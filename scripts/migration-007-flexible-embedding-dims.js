#!/usr/bin/env node
/**
 * migration-007-flexible-embedding-dims.js
 *
 * 작성자: 최진호
 * 작성일: 2026-03-08
 *
 * EMBEDDING_DIMENSIONS 환경변수에 따라 fragments.embedding 컬럼 타입을 조정한다.
 * - ≤2000차원: vector(N)  + HNSW 인덱스
 * - >2000차원: halfvec(N) + HNSW 인덱스 (pgvector ≥0.7.0 필요)
 *
 * 실행: EMBEDDING_DIMENSIONS=3072 DATABASE_URL=$DATABASE_URL node scripts/migration-007-flexible-embedding-dims.js
 *
 * 주의: 컬럼 타입 변경 시 기존 임베딩 데이터가 NULL로 초기화된다.
 *       실행 후 backfill-embeddings.js로 재임베딩이 필요하다.
 */

import { getPrimaryPool } from "../lib/tools/db.js";
import { EMBEDDING_DIMENSIONS } from "../lib/config.js";

const SCHEMA = "agent_memory";
const TARGETS = [
  { table: "fragments", indexName: "idx_frag_embedding" },
  { table: "morpheme_dict", indexName: "idx_morpheme_dict_embedding" }
];

async function migrateEmbeddingColumn(pool, { table, indexName }, colType, opsType) {
  const { rows } = await pool.query(
    `SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS full_type
       FROM pg_attribute a
       JOIN pg_class c ON a.attrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = $1
        AND c.relname = $2
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped`,
    [SCHEMA, table]
  );

  if (rows.length === 0) {
    console.error(`컬럼 ${SCHEMA}.${table}.embedding 을 찾을 수 없습니다.`);
    process.exit(1);
  }

  const currentType = rows[0].full_type;
  console.log(`[${table}] 현재 컬럼 타입: ${currentType}`);

  if (currentType === colType) {
    console.log(`[${table}] 컬럼 타입이 이미 목표 타입과 일치합니다. 스킵.`);
    return;
  }

  console.log(`[${table}] 인덱스 ${indexName} 삭제 중...`);
  await pool.query(`DROP INDEX IF EXISTS ${SCHEMA}.${indexName}`);

  console.log(`[${table}] 컬럼 타입 변환 중: ${currentType} → ${colType} (임베딩 데이터 NULL 초기화)`);
  await pool.query(
    `ALTER TABLE ${SCHEMA}.${table}
     ALTER COLUMN embedding TYPE ${colType} USING NULL`
  );

  console.log(`[${table}] HNSW 인덱스 재생성 중...`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${indexName}
     ON ${SCHEMA}.${table}
     USING hnsw (embedding ${opsType})
     WITH (m = 16, ef_construction = 64)
     WHERE embedding IS NOT NULL`
  );
}

async function main() {
  const dims       = EMBEDDING_DIMENSIONS;
  const useHalfvec = dims > 2000;
  const colType    = useHalfvec ? `halfvec(${dims})` : `vector(${dims})`;
  const opsType    = useHalfvec ? "halfvec_cosine_ops" : "vector_cosine_ops";

  console.log(`EMBEDDING_DIMENSIONS = ${dims}`);
  console.log(`컬럼 타입 → ${colType} (${useHalfvec ? "halfvec — pgvector ≥0.7.0 필요" : "vector"})`);

  const pool = getPrimaryPool();

  try {
    for (const target of TARGETS) {
      await migrateEmbeddingColumn(pool, target, colType, opsType);
    }

    console.log("마이그레이션 완료.");
    console.log("fragments/morpheme_dict 임베딩 데이터가 초기화되었습니다. backfill-embeddings.js 또는 reembed-all.js를 실행하여 재임베딩하세요.");
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
