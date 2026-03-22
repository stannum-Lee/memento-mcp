/**
 * Agent Memory Schema - Fragment-Based Memory System
 *
 * Execution: psql -U postgres -d memento -f memory-schema.sql
 */

CREATE SCHEMA IF NOT EXISTS agent_memory;

SET search_path TO agent_memory, public;

CREATE TABLE IF NOT EXISTS agent_memory.fragments (
    id                TEXT PRIMARY KEY,
    content           TEXT NOT NULL,
    topic             TEXT NOT NULL,
    keywords          TEXT[] NOT NULL DEFAULT '{}',
    type              TEXT NOT NULL CHECK (type IN ('fact','decision','error','preference','procedure','relation')),
    importance        REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
    content_hash      TEXT NOT NULL,
    source            TEXT,
    linked_to         TEXT[] DEFAULT '{}',
    agent_id          TEXT NOT NULL DEFAULT 'default',
    access_count      INTEGER DEFAULT 0,
    accessed_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    valid_from        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_to          TIMESTAMPTZ,
    superseded_by     TEXT REFERENCES agent_memory.fragments(id),
    ttl_tier          TEXT DEFAULT 'warm' CHECK (ttl_tier IN ('hot','warm','cold','permanent')),
    estimated_tokens  INTEGER DEFAULT 0,
    utility_score     REAL DEFAULT 1.0,
    verified_at       TIMESTAMPTZ DEFAULT NOW(),
    key_id            TEXT REFERENCES agent_memory.api_keys(id) ON DELETE SET NULL,
    quality_verified  BOOLEAN DEFAULT NULL,
    ema_activation    FLOAT DEFAULT 0.0,
    ema_last_updated  TIMESTAMPTZ,
    embedding         vector(1536)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_frag_hash
    ON agent_memory.fragments(content_hash);
CREATE INDEX IF NOT EXISTS idx_frag_topic
    ON agent_memory.fragments(topic);
CREATE INDEX IF NOT EXISTS idx_frag_type
    ON agent_memory.fragments(type);
CREATE INDEX IF NOT EXISTS idx_frag_keywords
    ON agent_memory.fragments USING GIN(keywords);
CREATE INDEX IF NOT EXISTS idx_frag_importance
    ON agent_memory.fragments(importance DESC);
CREATE INDEX IF NOT EXISTS idx_frag_created
    ON agent_memory.fragments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_frag_agent
    ON agent_memory.fragments(agent_id);
CREATE INDEX IF NOT EXISTS idx_frag_linked
    ON agent_memory.fragments USING GIN(linked_to);
CREATE INDEX IF NOT EXISTS idx_frag_ttl
    ON agent_memory.fragments(ttl_tier, created_at);
CREATE INDEX IF NOT EXISTS idx_frag_source
    ON agent_memory.fragments(source);
CREATE INDEX IF NOT EXISTS idx_frag_verified
    ON agent_memory.fragments(verified_at);
CREATE INDEX IF NOT EXISTS idx_frag_key_id
    ON agent_memory.fragments(key_id)
    WHERE key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_frag_valid_from
    ON agent_memory.fragments(valid_from);
CREATE INDEX IF NOT EXISTS idx_frag_valid_to
    ON agent_memory.fragments(valid_to)
    WHERE valid_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_frag_ema_activation
    ON agent_memory.fragments(ema_activation DESC);
CREATE INDEX IF NOT EXISTS idx_frag_quality_verified
    ON agent_memory.fragments(quality_verified)
    WHERE quality_verified IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_frag_temporal_active
    ON agent_memory.fragments(agent_id, valid_from)
    WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_frag_embedding
    ON agent_memory.fragments
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_memory.fragment_links (
    id            BIGSERIAL PRIMARY KEY,
    from_id       TEXT NOT NULL REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
    to_id         TEXT NOT NULL REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
    relation_type TEXT DEFAULT 'related' CHECK (relation_type IN ('related','caused_by','resolved_by','part_of','contradicts','superseded_by','co_retrieved')),
    weight        INTEGER NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(from_id, to_id)
);

CREATE INDEX IF NOT EXISTS idx_link_from
    ON agent_memory.fragment_links(from_id);
CREATE INDEX IF NOT EXISTS idx_link_to
    ON agent_memory.fragment_links(to_id);
CREATE INDEX IF NOT EXISTS idx_fragment_links_weight
    ON agent_memory.fragment_links(from_id, weight DESC);

CREATE TABLE IF NOT EXISTS agent_memory.tool_feedback (
    id            BIGSERIAL PRIMARY KEY,
    tool_name     TEXT NOT NULL,
    relevant      BOOLEAN NOT NULL,
    sufficient    BOOLEAN NOT NULL,
    suggestion    TEXT,
    context       TEXT,
    session_id    TEXT,
    trigger_type  TEXT NOT NULL DEFAULT 'voluntary' CHECK (trigger_type IN ('sampled', 'voluntary')),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tf_tool
    ON agent_memory.tool_feedback(tool_name);
CREATE INDEX IF NOT EXISTS idx_tf_created
    ON agent_memory.tool_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tf_session
    ON agent_memory.tool_feedback(session_id);

CREATE TABLE IF NOT EXISTS agent_memory.task_feedback (
    id               BIGSERIAL PRIMARY KEY,
    session_id       TEXT NOT NULL,
    overall_success  BOOLEAN NOT NULL,
    tool_highlights  TEXT[],
    tool_pain_points TEXT[],
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_taskfb_session
    ON agent_memory.task_feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_taskfb_created
    ON agent_memory.task_feedback(created_at DESC);

CREATE TABLE IF NOT EXISTS agent_memory.fragment_versions (
    id           BIGSERIAL PRIMARY KEY,
    fragment_id  TEXT NOT NULL REFERENCES agent_memory.fragments(id) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    topic        TEXT,
    keywords     TEXT[],
    type         TEXT,
    importance   REAL,
    amended_at   TIMESTAMPTZ DEFAULT NOW(),
    amended_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_ver_frag
    ON agent_memory.fragment_versions(fragment_id);

ALTER TABLE agent_memory.fragments
    ADD COLUMN IF NOT EXISTS is_anchor BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_frag_anchor
    ON agent_memory.fragments(is_anchor)
    WHERE is_anchor = TRUE;

ALTER TABLE agent_memory.fragments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fragment_isolation_policy ON agent_memory.fragments;
CREATE POLICY fragment_isolation_policy ON agent_memory.fragments
    USING (
        agent_id = current_setting('app.current_agent_id', true)
        OR agent_id = 'default'
        OR current_setting('app.current_agent_id', true) IN ('system', 'admin')
    );
