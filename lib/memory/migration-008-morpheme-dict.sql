-- NOTE: vector_cosine_ops is auto-replaced by migrate.js with the correct
--       ops class (halfvec_cosine_ops when embedding column is halfvec type).
-- migration-008: 형태소 임베딩 사전 테이블
--
-- 기존 로컬 런타임이 vector / halfvec 어느 타입을 쓰고 있든
-- fragments.embedding 스키마를 따라가도록 호환성을 유지한다.

DO $$
DECLARE
  embedding_type TEXT := 'vector';
  embedding_dims INTEGER := 1536;
  embedding_ops  TEXT := 'vector_cosine_ops';
BEGIN
  SELECT
    t.typname,
    CASE WHEN a.atttypmod > 0 THEN a.atttypmod - 4 ELSE 1536 END
  INTO embedding_type, embedding_dims
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
  WHERE n.nspname = 'agent_memory'
    AND c.relname = 'fragments'
    AND a.attname = 'embedding'
    AND NOT a.attisdropped
  LIMIT 1;

  IF embedding_type = 'halfvec' THEN
    embedding_ops := 'halfvec_cosine_ops';
  END IF;

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS agent_memory.morpheme_dict (
      morpheme   TEXT PRIMARY KEY,
      embedding  %s(%s),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )',
    embedding_type,
    embedding_dims
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_morpheme_dict_embedding
      ON agent_memory.morpheme_dict
      USING hnsw (embedding %s)',
    embedding_ops
  );
END $$;
