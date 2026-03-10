#!/usr/bin/env node
/**
 * Adjust fragments.embedding to the configured embedding dimensions.
 *
 * - <= 2000 dims: vector(N) + HNSW
 * - > 2000 dims: halfvec(N) + HNSW
 *
 * Existing embeddings are reset to NULL because PostgreSQL cannot cast
 * between different pgvector dimensions safely. Run backfill afterwards
 * when migrating a populated database.
 */

import { getPrimaryPool } from "../tools/db.js";
import { EMBEDDING_DIMENSIONS } from "../config.js";

const SCHEMA = "agent_memory";
const TABLE = "fragments";
const INDEX_NAME = "idx_frag_embedding";

async function main() {
  const dims = EMBEDDING_DIMENSIONS;
  const useHalfvec = dims > 2000;
  const colType = useHalfvec ? `halfvec(${dims})` : `vector(${dims})`;
  const opsType = useHalfvec ? "halfvec_cosine_ops" : "vector_cosine_ops";

  console.log(`EMBEDDING_DIMENSIONS = ${dims}`);
  console.log(`Target column type = ${colType}`);

  const pool = getPrimaryPool();

  try {
    const { rows } = await pool.query(
      `SELECT
         a.atttypid::regtype::text AS udt_name,
         format_type(a.atttypid, a.atttypmod) AS formatted_type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND c.relname = $2
         AND a.attname = 'embedding'
         AND a.attnum > 0
         AND NOT a.attisdropped`,
      [SCHEMA, TABLE]
    );

    if (rows.length === 0) {
      console.error(`Column ${SCHEMA}.${TABLE}.embedding not found.`);
      process.exit(1);
    }

    const currentType = rows[0].udt_name;
    const currentFormattedType = rows[0].formatted_type;
    const targetUdt = useHalfvec ? "halfvec" : "vector";

    console.log(`Current column type = ${currentFormattedType}`);

    if (currentType === targetUdt && currentFormattedType === colType) {
      console.log("Column type already matches target. Skipping.");
      return;
    }

    console.log(`Dropping index ${INDEX_NAME} if it exists...`);
    await pool.query(`DROP INDEX IF EXISTS ${SCHEMA}.${INDEX_NAME}`);

    console.log(`Altering column type from ${currentFormattedType} to ${colType}...`);
    await pool.query(
      `ALTER TABLE ${SCHEMA}.${TABLE}
       ALTER COLUMN embedding TYPE ${colType} USING NULL`
    );

    console.log("Recreating HNSW index...");
    await pool.query(
      `CREATE INDEX IF NOT EXISTS ${INDEX_NAME}
       ON ${SCHEMA}.${TABLE}
       USING hnsw (embedding ${opsType})
       WITH (m = 16, ef_construction = 64)
       WHERE embedding IS NOT NULL`
    );

    console.log("Migration complete.");
    console.log("Existing embeddings were reset to NULL. Run backfill if needed.");
  } finally {
    await pool.end();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
