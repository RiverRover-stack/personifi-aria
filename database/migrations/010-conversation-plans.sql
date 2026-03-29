-- Migration 010: Conversation Plans
-- Stores concrete plans extracted from session summaries for future stimulus firing.

CREATE TABLE IF NOT EXISTS conversation_plans (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           TEXT NOT NULL,
    session_id        TEXT NOT NULL,
    plan_type         TEXT NOT NULL,  -- 'outing', 'travel', 'food', 'study', 'purchase', 'event', 'other'
    description       TEXT NOT NULL,  -- human-readable: "Coffee at Third Wave with Rahul on Friday"
    scheduled_for     DATE,           -- if a specific date was mentioned
    participants      TEXT[],         -- other user_ids in the plan, if known
    source_summary    TEXT,           -- the session summary snippet this was extracted from
    status            TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'fired', 'expired', 'cancelled'
    stimulus_fired_at TIMESTAMPTZ,
    expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_plans_user_id ON conversation_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_plans_expires ON conversation_plans(expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_conversation_plans_scheduled ON conversation_plans(scheduled_for) WHERE status = 'pending';
