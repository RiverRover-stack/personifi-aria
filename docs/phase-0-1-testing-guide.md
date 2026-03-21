# Phase 0 + Phase 1 Testing Guide

Step-by-step verification for both phases.

---

## Phase 0 Verification (DB Migrations + Bedrock Infra)

### 1. Check all 6 tables exist

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

### 2. Insert/select round-trip on proactive_state

```sql
INSERT INTO proactive_state (user_id, stimulus_type, stimulus_key, score, data)
VALUES ('TEST_USER_ID', 'weather', 'rain_commute_morning', 0.85,
        '{"condition":"rain","area":"Koramangala"}');

SELECT * FROM proactive_state WHERE user_id = 'TEST_USER_ID';
```

### 3. Insert dummy data on all 6 tables

```sql
-- stimulus_cache
INSERT INTO stimulus_cache (source, cache_key, data_json, ttl_seconds)
VALUES ('openweather', 'bengaluru_current', '{"temp":28,"condition":"rain"}', 300);

-- tool_results
INSERT INTO tool_results (user_id, tool_name, args_hash, result, expires_at)
VALUES ('TEST_USER_ID', 'compare_rides', 'abc123hash',
        '{"uber":250,"ola":230,"rapido":180}', NOW() + INTERVAL '1 hour');

-- pulse_history
INSERT INTO pulse_history (user_id, score, state, previous_state, delta, signal_source)
VALUES ('TEST_USER_ID', 65, 'ENGAGED', 'CURIOUS', 15, 'user_message');

-- signal_packets
INSERT INTO signal_packets (user_id, invalidated_stimuli, current_direction, extracted_intents, engagement_signal)
VALUES ('TEST_USER_ID', '{}', 'food_ordering', '{"biryani","delivery"}', 'positive');

-- pushback_tracker
INSERT INTO pushback_tracker (user_id, stimulus_type, rejection_count)
VALUES ('TEST_USER_ID', 'weather', 0);
```

### 4. Verify indexes exist

```sql
SELECT indexname FROM pg_indexes
WHERE tablename IN ('proactive_state', 'tool_results', 'pulse_history', 'signal_packets', 'pushback_tracker')
ORDER BY indexname;
```

### 5. Cleanup test data

```sql
DELETE FROM signal_packets WHERE user_id = 'TEST_USER_ID';
DELETE FROM pulse_history WHERE user_id = 'TEST_USER_ID';
DELETE FROM tool_results WHERE user_id = 'TEST_USER_ID';
DELETE FROM proactive_state WHERE user_id = 'TEST_USER_ID';
DELETE FROM pushback_tracker WHERE user_id = 'TEST_USER_ID';
DELETE FROM stimulus_cache WHERE source = 'openweather' AND cache_key = 'bengaluru_current';
```

---

## Phase 1 Verification (Fusion Engine + Soul Files)

### 1. Type check

```bash
npx tsc --noEmit
```

Expected: no errors.

### 2. Run all tests

```bash
npm run test
```

Expected: all existing tests pass (zero regressions).

### 3. Run Fusion Engine unit tests

```bash
npm run test -- src/fusion/
```

Expected: all Fusion Engine tests pass:
- Scoring formula tests (known inputs -> expected scores)
- Mode switching tests (each Pulse state -> correct threshold)
- Proactive decision tests (FIRE/BUFFER/DROP)
- Preference matching tests
- Fatigue calculation tests

### 4. Soul-v2 token check

Verify soul-v2.md is under ~500 tokens:

```bash
wc -w config/soul-v2.md
```

Expected: ~350-450 words (roughly maps to ~500 tokens for Llama 70B).

### 5. Handler parallel test

Set in `.env`:
```
FUSION_ENGINE_ENABLED=true
SOUL_V2_ENABLED=true
```

Start the bot locally and send a test message. Check logs for:
```
[Fusion/Reactive] user=... route=respond confidence=... proactive_count=0
```

### 6. Regression test

With both flags enabled, send "hello" and verify:
- Normal bot response is unchanged
- Response time is not significantly impacted
- No errors in logs

### 7. Flag-off regression

With both flags set to `false` (or unset), verify:
- No `[Fusion/Reactive]` log lines
- personality.ts uses SOUL.md (not soul-v2.md)
- Behavior is identical to pre-Phase 1

### 8. Reactive decision manual test

If you have DB access, insert a proactive_state row and verify the Fusion Engine detects it:

```sql
INSERT INTO proactive_state (user_id, stimulus_type, stimulus_key, score, data)
VALUES ('<your_test_user_id>', 'weather', 'test_rain', 0.85,
        '{"condition":"rain","area":"Koramangala"}');
```

Then send a message and check logs for:
```
[Fusion/Reactive] user=... route=respond confidence=... proactive_count=1
```

Note: `proactive_count=1` confirms the Fusion Engine found the stimulus.

---

## E2E Test Recipe

1. `npx tsc --noEmit` — no type errors
2. `npm run test` — all tests pass
3. `npm run test -- src/fusion/` — Fusion Engine tests pass
4. Set `FUSION_ENGINE_ENABLED=true` and `SOUL_V2_ENABLED=true` in .env
5. Start bot locally, send a test message
6. Check logs for `[Fusion/Reactive]` line
7. Verify normal bot response is unchanged
