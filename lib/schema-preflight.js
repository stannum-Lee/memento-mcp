import { getPrimaryPool } from "./tools/db.js";

const REQUIRED_COLUMNS = {
  fragments: [
    "valid_from",
    "valid_to",
    "superseded_by",
    "ema_activation",
    "ema_last_updated",
    "key_id",
    "quality_verified",
  ],
  fragment_links: [
    "weight",
  ],
};

const REQUIRED_RELATIONS = [
  "related",
  "caused_by",
  "resolved_by",
  "part_of",
  "contradicts",
  "superseded_by",
  "co_retrieved",
];

let cachedPreflight = null;

export async function validateSchemaCapabilities() {
  const pool = getPrimaryPool();
  const columnResult = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'agent_memory'
      AND (
        (table_name = 'fragments' AND column_name = ANY($1::text[]))
        OR
        (table_name = 'fragment_links' AND column_name = ANY($2::text[]))
      )
  `, [REQUIRED_COLUMNS.fragments, REQUIRED_COLUMNS.fragment_links]);

  const found = new Set(
    columnResult.rows.map((row) => `${row.table_name}.${row.column_name}`)
  );
  const missing = [];

  for (const column of REQUIRED_COLUMNS.fragments) {
    if (!found.has(`fragments.${column}`)) {
      missing.push(`fragments.${column}`);
    }
  }
  for (const column of REQUIRED_COLUMNS.fragment_links) {
    if (!found.has(`fragment_links.${column}`)) {
      missing.push(`fragment_links.${column}`);
    }
  }

  const constraintResult = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conname = 'fragment_links_relation_type_check'
      AND connamespace = 'agent_memory'::regnamespace
  `);
  const relationDefinition = String(constraintResult.rows[0]?.definition || "");
  const missingRelations = REQUIRED_RELATIONS.filter((relation) => !relationDefinition.includes(`'${relation}'`));
  if (missingRelations.length > 0) {
    missing.push(`fragment_links_relation_type_check:${missingRelations.join(",")}`);
  }

  if (missing.length > 0) {
    const error = new Error(`Schema capability preflight failed: ${missing.join("; ")}`);
    error.missing = missing;
    throw error;
  }

  cachedPreflight = {
    ok: true,
    checkedAt: new Date().toISOString(),
    relationConstraint: relationDefinition,
    missing: [],
  };
  return cachedPreflight;
}

export function getCachedSchemaPreflight() {
  return cachedPreflight;
}
