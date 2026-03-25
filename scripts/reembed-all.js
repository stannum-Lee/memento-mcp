#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPrimaryPool, queryWithAgentVector } from "../lib/tools/db.js";
import {
  EMBEDDING_ENABLED,
  generateEmbedding,
  generateBatchEmbeddings,
  prepareTextForEmbedding,
  vectorToSql
} from "../lib/tools/embedding.js";

const SCHEMA = "agent_memory";
const BATCH_SIZE = 50;
const DELAY_MS = 200;

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

async function fetchCount(sql) {
  const { rows } = await queryWithAgentVector("system", sql);
  return Number(rows[0]?.count || 0);
}

async function reembedFragments() {
  const total = await fetchCount(`SELECT COUNT(*) AS count FROM ${SCHEMA}.fragments`);
  let offset = 0;
  let embedded = 0;
  let failed = 0;

  while (offset < total) {
    const { rows } = await queryWithAgentVector(
      "system",
      `SELECT id, content
         FROM ${SCHEMA}.fragments
        ORDER BY importance DESC, created_at DESC, id ASC
        OFFSET $1 LIMIT $2`,
      [offset, BATCH_SIZE]
    );

    if (rows.length === 0) break;

    const preparedRows = rows.map((row) => ({
      id: row.id,
      text: prepareTextForEmbedding(row.content, 500)
    }));

    try {
      const vectors = await generateBatchEmbeddings(preparedRows.map((row) => row.text), BATCH_SIZE);

      for (let index = 0; index < preparedRows.length; index++) {
        const row = preparedRows[index];
        const vector = vectors[index];

        await queryWithAgentVector(
          "system",
          `UPDATE ${SCHEMA}.fragments
              SET embedding = $2::vector
            WHERE id = $1`,
          [row.id, vectorToSql(vector)],
          "write"
        );
        embedded += 1;
        process.stdout.write(`\rFragments: ${embedded}/${total} (failed: ${failed})`);
      }
    } catch (batchError) {
      console.warn(`\nFragment batch at offset ${offset} failed, retrying row-by-row: ${batchError.message}`);
      for (const row of preparedRows) {
        try {
          const vector = await generateEmbedding(row.text);
          await queryWithAgentVector(
            "system",
            `UPDATE ${SCHEMA}.fragments
                SET embedding = $2::vector
              WHERE id = $1`,
            [row.id, vectorToSql(vector)],
            "write"
          );
          embedded += 1;
          process.stdout.write(`\rFragments: ${embedded}/${total} (failed: ${failed})`);
        } catch (error) {
          failed += 1;
          process.stdout.write(`\rFragments: ${embedded}/${total} (failed: ${failed})`);
          console.warn(`\nFailed fragment ${row.id}: ${error.message}`);
        }
      }
    }

    offset += rows.length;
    if (offset < total) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }

  process.stdout.write("\n");
  return { total, embedded, failed };
}

async function reembedMorphemes() {
  const pool = getPrimaryPool();
  const { rows } = await pool.query(
    `SELECT morpheme
       FROM ${SCHEMA}.morpheme_dict
      ORDER BY morpheme ASC`
  );

  const total = rows.length;
  let offset = 0;
  let embedded = 0;
  let failed = 0;

  while (offset < total) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);

    try {
      const vectors = await generateBatchEmbeddings(batch.map((row) => row.morpheme), BATCH_SIZE);

      for (let index = 0; index < batch.length; index++) {
        const row = batch[index];
        const vector = vectors[index];

        await pool.query(
          `UPDATE ${SCHEMA}.morpheme_dict
              SET embedding = $2::vector
            WHERE morpheme = $1`,
          [row.morpheme, vectorToSql(vector)]
        );
        embedded += 1;
        process.stdout.write(`\rMorphemes: ${embedded}/${total} (failed: ${failed})`);
      }
    } catch (batchError) {
      console.warn(`\nMorpheme batch at offset ${offset} failed, retrying row-by-row: ${batchError.message}`);
      for (const row of batch) {
        try {
          const vector = await generateEmbedding(row.morpheme);
          await pool.query(
            `UPDATE ${SCHEMA}.morpheme_dict
                SET embedding = $2::vector
              WHERE morpheme = $1`,
            [row.morpheme, vectorToSql(vector)]
          );
          embedded += 1;
          process.stdout.write(`\rMorphemes: ${embedded}/${total} (failed: ${failed})`);
        } catch (error) {
          failed += 1;
          process.stdout.write(`\rMorphemes: ${embedded}/${total} (failed: ${failed})`);
          console.warn(`\nFailed morpheme ${row.morpheme}: ${error.message}`);
        }
      }
    }

    offset += batch.length;
    if (offset < total) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }

  process.stdout.write("\n");
  return { total, embedded, failed };
}

async function main() {
  loadEnvFile(resolve(".env"));

  if (!EMBEDDING_ENABLED) {
    console.error("Embedding provider is not configured.");
    process.exit(1);
  }

  const fragmentResult = await reembedFragments();
  const morphemeResult = await reembedMorphemes();

  console.log(JSON.stringify({
    fragments: fragmentResult,
    morphemes: morphemeResult
  }, null, 2));

  const pool = getPrimaryPool();
  if (pool) await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  const pool = getPrimaryPool();
  if (pool) await pool.end().catch(() => {});
  process.exit(1);
});
