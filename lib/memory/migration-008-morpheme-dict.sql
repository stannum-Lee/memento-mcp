-- migration-008: morpheme_dict cache table
--
-- Keep the morpheme embedding column aligned with agent_memory.fragments.embedding
-- so 1024-dim local transformers setups and >2000-dim halfvec setups both work.

DO $$
DECLARE
  target_embedding_type text;
  target_ops_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO target_embedding_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'agent_memory'
     AND c.relname = 'fragments'
     AND a.attname = 'embedding'
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF target_embedding_type IS NULL THEN
    target_embedding_type := 'vector(1536)';
  END IF;

  target_ops_type := CASE
    WHEN target_embedding_type LIKE 'halfvec(%' THEN 'halfvec_cosine_ops'
    ELSE 'vector_cosine_ops'
  END;

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS agent_memory.morpheme_dict (
       morpheme   TEXT PRIMARY KEY,
       embedding  %s,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )',
    target_embedding_type
  );

  EXECUTE format(
    'ALTER TABLE agent_memory.morpheme_dict
       ALTER COLUMN embedding TYPE %s
       USING NULL',
    target_embedding_type
  );

  EXECUTE 'DROP INDEX IF EXISTS agent_memory.idx_morpheme_dict_embedding';
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS idx_morpheme_dict_embedding
       ON agent_memory.morpheme_dict
       USING ivfflat (embedding %s)
       WITH (lists = 50)',
    target_ops_type
  );
END $$;
