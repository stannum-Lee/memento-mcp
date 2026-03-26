import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { buildMemoryQualityReport } from "../lib/memory/MemoryQualityReport.js";
import {
  isNoiseLikeFragment,
  isNoiseLikeStoredMorpheme,
  normalizeText
} from "../lib/memory/NoiseFilters.js";

const { Pool } = pg;
const SCHEMA = "agent_memory";

function parseArgs(argv) {
  const options = {
    outputPath: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output" && argv[index + 1]) {
      options.outputPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--output=")) {
      options.outputPath = arg.slice("--output=".length);
    }
  }

  return options;
}

function ensureOutputDirectory(outputPath) {
  if (!outputPath) return;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
}

function buildSamples({ fragments = [], morphemes = [] } = {}) {
  const noisyFragments = fragments
    .filter((fragment) => isNoiseLikeFragment(fragment))
    .slice(0, 8)
    .map((fragment) => ({
      id: fragment.id,
      topic: fragment.topic,
      type: fragment.type,
      created_at: fragment.created_at,
      preview: String(fragment.content || "").slice(0, 160)
    }));

  const noisyMorphemes = morphemes
    .map((row) => normalizeText(row.morpheme).trim())
    .filter((token) => token && isNoiseLikeStoredMorpheme(token))
    .slice(0, 16);

  return {
    noisyFragments,
    noisyMorphemes
  };
}

async function main() {
  const { outputPath } = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    const [
      fragmentsResult,
      morphemesResult,
      relationsResult,
      searchEventsResult,
      linkedFeedbackResult
    ] = await Promise.all([
      pool.query(`
        SELECT id, topic, content, source, type, importance, created_at, ttl_tier, is_anchor
          FROM ${SCHEMA}.fragments
      `),
      pool.query(`
        SELECT morpheme
          FROM ${SCHEMA}.morpheme_dict
      `),
      pool.query(`
        SELECT relation_type, COUNT(*)::int AS count
          FROM ${SCHEMA}.fragment_links
         GROUP BY relation_type
      `),
      pool.query(`
        SELECT COUNT(*)::int AS count
          FROM ${SCHEMA}.search_events
      `),
      pool.query(`
        SELECT COUNT(*)::int AS count
          FROM ${SCHEMA}.tool_feedback
         WHERE search_event_id IS NOT NULL
      `)
    ]);

    const report = buildMemoryQualityReport({
      fragments: fragmentsResult.rows,
      morphemes: morphemesResult.rows,
      relationCounts: relationsResult.rows,
      searchEventCount: searchEventsResult.rows[0]?.count ?? 0,
      linkedFeedbackCount: linkedFeedbackResult.rows[0]?.count ?? 0
    });
    report.samples = buildSamples({
      fragments: fragmentsResult.rows,
      morphemes: morphemesResult.rows
    });

    ensureOutputDirectory(outputPath);
    if (outputPath) {
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }

    const summary = {
      outcome: report.outcome,
      reportPath: outputPath || null,
      failedChecks: report.checks
        .filter((check) => check.status === "fail")
        .map((check) => ({ name: check.name, message: check.message })),
      metrics: report.metrics
    };

    console.log(JSON.stringify(summary));
    process.exitCode = report.outcome === "pass" ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
