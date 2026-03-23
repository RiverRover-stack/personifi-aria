-- Migration 006: Saved Locations for Location Mini App (Phase 3)
-- Stores user-labelled locations (Home, Office, etc.) for quick reuse

CREATE TABLE IF NOT EXISTS saved_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    label VARCHAR(50) NOT NULL,
    area VARCHAR(200) NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_loc_user_label
    ON saved_locations(user_id, LOWER(label));

CREATE INDEX IF NOT EXISTS idx_saved_loc_user
    ON saved_locations(user_id);
