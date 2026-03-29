-- Migration 011: Weekly Digests
-- Stores compiled weekly summaries of session_summaries for long-term memory.

CREATE TABLE IF NOT EXISTS weekly_digests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT NOT NULL,
    week_start  DATE NOT NULL,
    week_end    DATE NOT NULL,
    digest_text TEXT NOT NULL,  -- compact 200-word summary of the week
    topics      TEXT[],         -- main topics discussed
    entities    JSONB,          -- key people, places, things with sentiment
    plan_count  INT DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_weekly_digests_user ON weekly_digests(user_id, week_start DESC);
