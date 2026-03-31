-- Migration 019: HNSW index tuning for improved L3 search latency
-- Current:  m=16, ef_construction=64  (default ef_search=40)
-- Target:   m=16, ef_construction=128 (ef_search=80 set at session level)
--
-- This repository allows either vector(N) or halfvec(N) embeddings depending on
-- the configured embedding dimensions.  The migration therefore discovers the
-- live embedding column type and matching HNSW operator class instead of
-- hardcoding a single schema-qualified opclass.

DROP INDEX IF EXISTS agent_memory.idx_frag_embedding;

DO $$
DECLARE
  embedding_type text;
  opclass_name text;
  opclass_schema text;
BEGIN -- plpgsql block; keep on same line so migrate.js does not strip it
  SELECT pg_catalog.format_type(a.atttypid, a.atttypmod)
    INTO embedding_type
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
   WHERE n.nspname = 'agent_memory'
     AND c.relname = 'fragments'
     AND a.attname = 'embedding'
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF embedding_type IS NULL THEN
    RAISE EXCEPTION 'agent_memory.fragments.embedding column not found';
  END IF;

  IF embedding_type LIKE 'halfvec(%' THEN
    opclass_name := 'halfvec_cosine_ops';
  ELSE
    opclass_name := 'vector_cosine_ops';
  END IF;

  SELECT ns.nspname
    INTO opclass_schema
    FROM pg_opclass oc
    JOIN pg_namespace ns ON ns.oid = oc.opcnamespace
    JOIN pg_am am ON am.oid = oc.opcmethod
   WHERE oc.opcname = opclass_name
     AND am.amname = 'hnsw'
   ORDER BY CASE WHEN ns.nspname = 'public' THEN 0 ELSE 1 END, ns.nspname
   LIMIT 1;

  IF opclass_schema IS NULL THEN
    RAISE EXCEPTION 'HNSW operator class % not found', opclass_name;
  END IF;

  EXECUTE format(
    'CREATE INDEX idx_frag_embedding
       ON agent_memory.fragments
       USING hnsw (embedding %I.%I)
       WITH (m = 16, ef_construction = 128)
       WHERE (embedding IS NOT NULL)',
    opclass_schema,
    opclass_name
  );
END $$;
