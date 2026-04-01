#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPrimaryPool, shutdownPool } from "../lib/tools/db.js";
import {
  EMBEDDING_ENABLED,
  generateBatchEmbeddings,
  generateEmbedding,
  vectorToSql
} from "../lib/tools/embedding.js";
import {
  EMBEDDING_PROVIDER,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS
} from "../lib/config.js";
import { MorphemeIndex } from "../lib/memory/MorphemeIndex.js";
import { getDefaultGeminiModel } from "../lib/gemini.js";

const SCHEMA = "agent_memory";
const TOKEN_DELAY_MS = 50;
const EMBED_BATCH_SIZE = 50;
const OUTPUT_ARG_INDEX = 2;

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchActiveFragments(pool) {
  const { rows } = await pool.query(
    `SELECT id, topic, content
       FROM ${SCHEMA}.fragments
      WHERE valid_to IS NULL
        AND content IS NOT NULL
      ORDER BY created_at ASC, id ASC`
  );
  return rows;
}

async function collectUniqueMorphemes(rows) {
  const index = new MorphemeIndex();
  const ordered = [];
  const seen = new Set();
  let processed = 0;

  for (const row of rows) {
    const tokens = await index.tokenize(row.content);
    for (const token of tokens) {
      if (!token || seen.has(token)) continue;
      seen.add(token);
      ordered.push(token);
    }
    processed += 1;
    process.stderr.write(`\rTokenizing fragments: ${processed}/${rows.length} | morphemes=${ordered.length}`);
    await sleep(TOKEN_DELAY_MS);
  }

  process.stderr.write("\n");
  return ordered;
}

async function truncateMorphemeDict(pool) {
  await pool.query(`TRUNCATE TABLE ${SCHEMA}.morpheme_dict`);
}

async function fetchLiveMorphemeTotal(pool) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS total FROM ${SCHEMA}.morpheme_dict`);
  return rows[0]?.total ?? 0;
}

async function insertMorphemeEmbeddings(pool, morphemes) {
  let inserted = 0;
  let failed = 0;

  for (let offset = 0; offset < morphemes.length; offset += EMBED_BATCH_SIZE) {
    const batch = morphemes.slice(offset, offset + EMBED_BATCH_SIZE);

    try {
      const vectors = await generateBatchEmbeddings(batch, EMBED_BATCH_SIZE);
      for (let index = 0; index < batch.length; index += 1) {
        await pool.query(
          `INSERT INTO ${SCHEMA}.morpheme_dict (morpheme, embedding)
           VALUES ($1, $2::vector)`,
          [batch[index], vectorToSql(vectors[index])]
        );
        inserted += 1;
        process.stderr.write(`\rRegistering morphemes: ${inserted}/${morphemes.length} (failed: ${failed})`);
      }
    } catch (batchError) {
      console.warn(`\nMorpheme batch at offset ${offset} failed, retrying row-by-row: ${batchError.message}`);
      for (const morpheme of batch) {
        try {
          const vector = await generateEmbedding(morpheme);
          await pool.query(
            `INSERT INTO ${SCHEMA}.morpheme_dict (morpheme, embedding)
             VALUES ($1, $2::vector)`,
            [morpheme, vectorToSql(vector)]
          );
          inserted += 1;
          process.stderr.write(`\rRegistering morphemes: ${inserted}/${morphemes.length} (failed: ${failed})`);
        } catch (error) {
          failed += 1;
          process.stderr.write(`\rRegistering morphemes: ${inserted}/${morphemes.length} (failed: ${failed})`);
          console.warn(`\nFailed morpheme ${morpheme}: ${error.message}`);
        }
      }
    }
  }

  process.stderr.write("\n");
  return { total: morphemes.length, inserted, failed };
}

async function main() {
  loadEnvFile(resolve(".env"));
  const outputPath = process.argv[OUTPUT_ARG_INDEX] ? resolve(process.argv[OUTPUT_ARG_INDEX]) : "";

  if (!EMBEDDING_ENABLED) {
    console.error("Embedding provider is not configured.");
    process.exit(1);
  }

  const pool = getPrimaryPool();
  const fragments = await fetchActiveFragments(pool);
  const morphemes = await collectUniqueMorphemes(fragments);
  await truncateMorphemeDict(pool);
  const rebuild = await insertMorphemeEmbeddings(pool, morphemes);
  const liveTotalAfterRebuild = await fetchLiveMorphemeTotal(pool);

  const report = {
    fragment_count: fragments.length,
    unique_morphemes: morphemes.length,
    morpheme_model: process.env.MORPHEME_GEMINI_MODEL || process.env.GEMINI_MODEL || getDefaultGeminiModel(),
    embedding_provider: EMBEDDING_PROVIDER,
    embedding_model: EMBEDDING_MODEL,
    embedding_dimensions: EMBEDDING_DIMENSIONS,
    live_total_after_rebuild: liveTotalAfterRebuild,
    rebuild
  };
  const json = JSON.stringify(report, null, 2);
  if (outputPath) {
    writeFileSync(outputPath, `${json}\n`, "utf8");
  }
  console.log(json);

  await shutdownPool().catch(() => {});
}

main().catch(async (error) => {
  console.error(error);
  await shutdownPool().catch(() => {});
  process.exit(1);
});
