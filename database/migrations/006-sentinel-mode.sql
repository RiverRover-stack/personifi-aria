-- Migration 006: Add Sentinel mode tracking columns to proactive_user_state
-- These columns power the PROACTIVE ↔ REACTIVE mode switch in the Sentinel loop.

ALTER TABLE proactive_user_state ADD COLUMN IF NOT EXISTS sentinel_mode TEXT DEFAULT 'REACTIVE'
    CHECK (sentinel_mode IN ('PROACTIVE', 'REACTIVE'));

ALTER TABLE proactive_user_state ADD COLUMN IF NOT EXISTS consecutive_positive INT DEFAULT 0;

ALTER TABLE proactive_user_state ADD COLUMN IF NOT EXISTS pushback_count INT DEFAULT 0;
