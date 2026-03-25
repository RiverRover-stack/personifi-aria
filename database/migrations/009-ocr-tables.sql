-- Migration 009: OCR Tables — Phase 5, Issue #135
-- Creates tables for mess menu OCR uploads and local event poster uploads.
-- These tables are populated by the admin OCR upload endpoints and read by
-- the mess-menu and local-event Sentinel stimulus collectors.
-- Branch: dev/fusion-architecture-v2

-- ============================================================
-- 1. mess_menus
-- Stores structured menu items extracted from mess menu photos.
-- Uploaded by mess admins; read by Sentinel to generate food stimuli.
-- ============================================================
CREATE TABLE IF NOT EXISTS mess_menus (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uploaded_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
    hostel_name  TEXT NOT NULL,
    meal_type    TEXT NOT NULL
        CHECK (meal_type IN ('breakfast', 'lunch', 'snack', 'dinner')),
    menu_date    DATE NOT NULL,
    items        JSONB NOT NULL DEFAULT '[]',
        -- Format: [{"name": "Dal Rice", "price": 40, "veg": true, "category": "main"}]
    raw_ocr_text TEXT,
    image_url    TEXT,
    verified     BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_menu UNIQUE (hostel_name, meal_type, menu_date)
);

-- Sentinel read path: fetch today's menu for a hostel + meal bucket
CREATE INDEX IF NOT EXISTS idx_mess_menus_hostel_date_meal
    ON mess_menus(hostel_name, menu_date, meal_type);

-- Admin review: find unverified menus
CREATE INDEX IF NOT EXISTS idx_mess_menus_unverified
    ON mess_menus(verified, created_at DESC)
    WHERE NOT verified;


-- ============================================================
-- 2. local_events
-- Stores local events extracted from event poster photos.
-- Uploaded by admins; read by Sentinel to generate event stimuli.
-- ============================================================
CREATE TABLE IF NOT EXISTS local_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    uploaded_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
    event_name   TEXT NOT NULL,
    venue        TEXT,
    event_date   TIMESTAMPTZ,
    description  TEXT,
    tags         TEXT[] NOT NULL DEFAULT '{}',
        -- e.g. {"music", "food", "tech", "sports"}
    image_url    TEXT,
    raw_ocr_text TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sentinel read path: tag-based interest matching
CREATE INDEX IF NOT EXISTS idx_local_events_tags
    ON local_events USING GIN (tags);

-- Time-window query: events in the next N days
CREATE INDEX IF NOT EXISTS idx_local_events_date
    ON local_events(event_date)
    WHERE event_date IS NOT NULL;
