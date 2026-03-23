-- Migration 008: Invite Codes for Friend Mini App (Phase 3)
-- Single-use invite codes for bilateral friend connections

CREATE TABLE IF NOT EXISTS invite_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(8) NOT NULL UNIQUE,
    inviter_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    used_by UUID REFERENCES users(user_id),
    used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
CREATE INDEX IF NOT EXISTS idx_invite_codes_inviter ON invite_codes(inviter_user_id);
