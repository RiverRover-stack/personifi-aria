-- Migration 007: Onboarding Enhancements (Phase 3)
-- Adds weight column to user_preferences for Sentinel scoring

ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS weight REAL DEFAULT 1.0;

-- Set initial weights per category
UPDATE user_preferences SET weight = 1.0 WHERE category = 'dietary';
UPDATE user_preferences SET weight = 1.0 WHERE category = 'budget';
UPDATE user_preferences SET weight = 0.9 WHERE category = 'travel_style';
UPDATE user_preferences SET weight = 0.8 WHERE category = 'entertainment';
UPDATE user_preferences SET weight = 0.8 WHERE category = 'time_preference';
UPDATE user_preferences SET weight = 0.9 WHERE category = 'dietary_restriction';
UPDATE user_preferences SET weight = 0.7 WHERE category = 'commute';
UPDATE user_preferences SET weight = 0.6 WHERE category = 'communication';
