# Phase 0 + Phase 1 Testing Guide

Verification steps for local dev and server deployment.

---

## Phase 0: DB Migrations (Fusion Tables)

### 1. Run the migration

```bash
psql "$DATABASE_URL" -f database/migrations/005-fusion-architecture-tables.sql
```

If already run, re-running is safe (`CREATE TABLE IF NOT EXISTS`).

### 2. Verify all 6 tables exist

```sql
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'proactive_state', 'stimulus_cache', 'tool_results',
    'pulse_history', 'signal_packets', 'pushback_tracker'
  )
ORDER BY tablename;
```

Expected: 6 rows.

### 3. Verify indexes exist

```sql
SELECT indexname, tablename FROM pg_indexes
WHERE indexname IN (
  'idx_proactive_state_user_status',
  'idx_proactive_state_expires_active',
  'idx_stimulus_cache_lookup',
  'idx_tool_results_lookup',
  'idx_pulse_history_user_time',
  'idx_signal_packets_unprocessed'
)
ORDER BY tablename, indexname;
```

Expected: 6 rows.

### 4. Verify constraints

```sql
SELECT constraint_name, table_name FROM information_schema.table_constraints
WHERE constraint_name IN (
  'uq_proactive_state_user_stimulus',
  'uq_stimulus_cache_source_key',
  'uq_tool_results_user_tool_args',
  'uq_pushback_tracker_user_type',
  'fk_proactive_state_result_ref'
)
ORDER BY table_name;
```

Expected: 5 rows.

### 5. Insert/select round-trip (requires a valid user_id from `users` table)

```sql
-- Get a test user_id (use an existing user)
SELECT user_id FROM users LIMIT 1;
-- Use the returned UUID below as <USER_UUID>

-- proactive_state
INSERT INTO proactive_state (user_id, stimulus_type, stimulus_key, score, data)
VALUES ('<USER_UUID>', 'weather', 'test_rain_commute', 0.85,
        '{"condition":"rain","area":"Koramangala"}')
ON CONFLICT (user_id, stimulus_key) DO NOTHING;

SELECT id, stimulus_type, stimulus_key, score, status
FROM proactive_state WHERE user_id = '<USER_UUID>';

-- stimulus_cache
INSERT INTO stimulus_cache (source, cache_key, data_json, ttl_seconds)
VALUES ('openweather', 'test_bengaluru', '{"temp":28,"condition":"rain"}', 300)
ON CONFLICT (source, cache_key) DO NOTHING;

SELECT source, cache_key, data_json, fetched_at
FROM stimulus_cache WHERE source = 'openweather' AND cache_key = 'test_bengaluru';

-- tool_results
INSERT INTO tool_results (user_id, tool_name, args_hash, result, expires_at)
VALUES ('<USER_UUID>', 'compare_rides', 'test_hash_abc',
        '{"uber":250,"ola":230,"rapido":180}', NOW() + INTERVAL '1 hour')
ON CONFLICT (user_id, tool_name, args_hash) DO NOTHING;

SELECT tool_name, args_hash, result, used
FROM tool_results WHERE user_id = '<USER_UUID>';

-- pulse_history
INSERT INTO pulse_history (user_id, score, state, previous_state, delta, signal_source)
VALUES ('<USER_UUID>', 65, 'ENGAGED', 'CURIOUS', 15, 'user_message');

SELECT score, state, previous_state, delta, signal_source
FROM pulse_history WHERE user_id = '<USER_UUID>' ORDER BY created_at DESC LIMIT 1;

-- signal_packets
INSERT INTO signal_packets (user_id, invalidated_stimuli, current_direction, extracted_intents, engagement_signal)
VALUES ('<USER_UUID>', ARRAY[]::text[], 'food_ordering', ARRAY['biryani','delivery']::text[], 'positive');

SELECT current_direction, extracted_intents, engagement_signal, processed
FROM signal_packets WHERE user_id = '<USER_UUID>' ORDER BY created_at DESC LIMIT 1;

-- pushback_tracker
INSERT INTO pushback_tracker (user_id, stimulus_type, rejection_count)
VALUES ('<USER_UUID>', 'weather', 0)
ON CONFLICT (user_id, stimulus_type) DO NOTHING;

SELECT stimulus_type, rejection_count
FROM pushback_tracker WHERE user_id = '<USER_UUID>';
```

### 6. Verify FK constraint works

```sql
-- This should FAIL with a foreign key violation (invalid user_id)
INSERT INTO proactive_state (user_id, stimulus_type, stimulus_key, score, data)
VALUES ('00000000-0000-0000-0000-000000000000', 'weather', 'fk_test', 0.5, '{}');
```

Expected: `ERROR: insert or update on table "proactive_state" violates foreign key constraint`

### 7. Cleanup test data

```sql
DELETE FROM signal_packets WHERE user_id = '<USER_UUID>' AND current_direction = 'food_ordering';
DELETE FROM pulse_history WHERE user_id = '<USER_UUID>' AND signal_source = 'user_message' AND delta = 15;
DELETE FROM tool_results WHERE user_id = '<USER_UUID>' AND args_hash = 'test_hash_abc';
DELETE FROM proactive_state WHERE user_id = '<USER_UUID>' AND stimulus_key = 'test_rain_commute';
DELETE FROM pushback_tracker WHERE user_id = '<USER_UUID>' AND stimulus_type = 'weather';
DELETE FROM stimulus_cache WHERE source = 'openweather' AND cache_key = 'test_bengaluru';
```

---

## Phase 1: Fusion Engine + Soul Files

### Local Dev Verification

#### 1. Type check

```bash
npx tsc --noEmit
```

Expected: no errors.

#### 2. Run Fusion Engine unit tests

```bash
npm run test -- src/fusion/
```

Expected: 37 tests pass — scoring, mode switching, pushback protocol, recovery protocol, proactive decisions.

#### 3. Run full test suite (regression check)

```bash
npm run test
```

Expected: no new failures. (Pre-existing failures in unrelated modules are OK.)

#### 4. Soul file token check

```bash
wc -w config/soul-v2.md config/sentinel-soul.md
```

Expected: soul-v2.md ~350-450 words (~500 tokens), sentinel-soul.md ~200-250 words (~300 tokens).

### Server Deployment Verification

#### 1. Pull and build

```bash
git pull origin dev/fusion-architecture-v2
npm install
npm run build
```

Expected: TypeScript compiles with no errors.

#### 2. Verify Phase 0 tables exist on server DB

Run the SQL from Phase 0 Step 2 above against your server PostgreSQL. If tables are missing, run the migration:

```bash
psql "$DATABASE_URL" -f database/migrations/005-fusion-architecture-tables.sql
```

#### 3. Set feature flags in `.env`

```bash
# Enable Fusion Engine (parallel logging mode — does not affect bot behavior)
FUSION_ENGINE_ENABLED=true

# Enable Soul v2 (uses soul-v2.md instead of SOUL.md for Layer 1)
SOUL_V2_ENABLED=true
```

Both default to `false`. Enable one at a time to isolate issues, or both together.

#### 4. Restart the bot

```bash
# However you restart your process (pm2, systemd, etc.)
pm2 restart aria    # example
```

#### 5. Send a test message and check logs

Send any message to the bot via Telegram. Check logs for:

```
[Fusion/Reactive] user=<uuid> route=respond confidence=1.00 proactive=0 invalidated=0
```

- `route=respond` — normal response (no proactive stimuli in DB yet)
- `proactive=0` — no active proactive_state rows for this user
- `invalidated=0` — nothing to invalidate

#### 6. Test with a proactive stimulus

Insert a dummy proactive_state row for a real user, then send a message:

```sql
INSERT INTO proactive_state (user_id, stimulus_type, stimulus_key, score, data)
VALUES ('<REAL_USER_UUID>', 'weather', 'test_rain_alert', 0.85,
        '{"condition":"rain","area":"Koramangala","forecast":"heavy rain in 2 hours"}')
ON CONFLICT (user_id, stimulus_key) DO NOTHING;
```

Send a message and check logs for:

```
[Fusion/Reactive] user=<uuid> route=respond confidence=... proactive=1 invalidated=0
```

`proactive=1` confirms the Fusion Engine found and processed the stimulus.

Clean up after testing:

```sql
DELETE FROM proactive_state WHERE stimulus_key = 'test_rain_alert';
```

#### 7. Regression check

With both flags enabled:
- Bot responds normally to "hello", "what's the weather", etc.
- Response time is not noticeably slower (Fusion runs in parallel, fire-and-forget)
- No errors in logs beyond the `[Fusion/Reactive]` info line

With both flags disabled (or unset):
- No `[Fusion/Reactive]` log lines appear
- `personality.ts` loads SOUL.md (not soul-v2.md)
- Behavior is identical to pre-fusion code

---

## Quick Checklist

| Step | Phase | Where | Pass? |
|------|-------|-------|-------|
| 6 tables exist | 0 | Server DB | |
| 6 indexes exist | 0 | Server DB | |
| 5 constraints exist | 0 | Server DB | |
| Insert/select round-trip | 0 | Server DB | |
| FK violation rejects bad user_id | 0 | Server DB | |
| `npm run build` succeeds | 1 | Server | |
| `[Fusion/Reactive]` log appears | 1 | Server logs | |
| Proactive stimulus detected | 1 | Server logs | |
| Bot responds normally | 1 | Telegram | |
| No regressions with flags off | 1 | Telegram | |
