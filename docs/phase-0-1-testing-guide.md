# Phase 0 + Phase 1: Testing & Deployment Guide

---

## Part A: Local Dev Verification

### Phase 0 — DB Tables

Run these against your local/dev database:

```sql
-- 1. Verify all 6 tables exist
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'proactive_state', 'stimulus_cache', 'tool_results',
    'pulse_history', 'signal_packets', 'pushback_tracker'
  )
ORDER BY tablename;
-- Expected: 6 rows

-- 2. Verify indexes
SELECT indexname, tablename FROM pg_indexes
WHERE indexname IN (
  'idx_proactive_state_user_status',
  'idx_proactive_state_expires_active',
  'idx_stimulus_cache_lookup',
  'idx_tool_results_lookup',
  'idx_pulse_history_user_time',
  'idx_signal_packets_unprocessed'
)
ORDER BY tablename;
-- Expected: 6 rows

-- 3. Verify constraints
SELECT constraint_name, table_name FROM information_schema.table_constraints
WHERE constraint_name IN (
  'uq_proactive_state_user_stimulus',
  'uq_stimulus_cache_source_key',
  'uq_tool_results_user_tool_args',
  'uq_pushback_tracker_user_type',
  'fk_proactive_state_result_ref'
)
ORDER BY table_name;
-- Expected: 5 rows
```

### Phase 1 — Fusion Engine Tests

```bash
# Type check
npx tsc --noEmit

# Fusion engine tests (37 tests)
npm run test -- src/fusion/

# Full regression
npm run test
```

---

## Part B: Server Deployment (Step-by-Step)

Your server: `root@aria-beta:~/personifi-aria` with Docker + Caddy.

### Step 1: SSH into server

```bash
ssh root@aria-beta
cd ~/personifi-aria
```

### Step 2: Pull the fusion branch

```bash
# Check what branch you're on
git branch

# Fetch and switch to the fusion branch
git fetch origin
git checkout dev/fusion-architecture-v2
git pull origin dev/fusion-architecture-v2
```

### Step 3: Run the DB migration

The migration is safe to re-run (`CREATE TABLE IF NOT EXISTS`).

```bash
# Run against your production database
psql "$DATABASE_URL" -f database/migrations/005-fusion-architecture-tables.sql
```

If `psql` isn't installed on the host, run it from inside the container or connect from your local machine:

```bash
# Option A: from inside a temporary container
docker run --rm -it postgres:15 psql "$DATABASE_URL" -f - < database/migrations/005-fusion-architecture-tables.sql

# Option B: from your local machine (replace with your actual DB URL)
psql "postgresql://user:pass@db-host:25060/dbname?sslmode=require" -f database/migrations/005-fusion-architecture-tables.sql
```

### Step 4: Verify tables were created

```bash
psql "$DATABASE_URL" -c "
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'proactive_state', 'stimulus_cache', 'tool_results',
    'pulse_history', 'signal_packets', 'pushback_tracker'
  )
ORDER BY tablename;
"
```

Expected: 6 rows.

### Step 5: Add fusion flags to `.env`

```bash
# Add these two lines to your .env file
echo '' >> .env
echo '# Fusion architecture (Phase 1)' >> .env
echo 'FUSION_ENGINE_ENABLED=true' >> .env
echo 'SOUL_V2_ENABLED=false' >> .env
```

Start with `FUSION_ENGINE_ENABLED=true` and `SOUL_V2_ENABLED=false` so you can verify the Fusion Engine logging first. Enable `SOUL_V2_ENABLED=true` separately once confirmed.

> Both flags default to `false`. With `FUSION_ENGINE_ENABLED=true`, the Fusion Engine runs in **parallel logging mode** — it logs decisions but does NOT change bot behavior. Safe to enable.

### Step 6: Rebuild and restart the container

```bash
# Stop the current container
docker compose down

# Rebuild with the new code (fusion engine files are new)
docker compose build --no-cache

# Start back up
docker compose up -d
```

Or if you use the prod compose with Caddy:

```bash
docker compose -f deploy/docker-compose.prod.yml down
docker compose -f deploy/docker-compose.prod.yml build --no-cache
DOMAIN=your-domain.com docker compose -f deploy/docker-compose.prod.yml up -d
```

### Step 7: Verify container is running

```bash
# Check container status
docker compose ps

# Check health endpoint
curl -s http://localhost:3000/health

# Follow logs
docker compose logs -f aria
```

### Step 8: Send a test message

Send any message to the bot on Telegram. Watch the logs for:

```
[Fusion/Reactive] user=<uuid> route=respond confidence=1.00 proactive=0 invalidated=0
```

- `route=respond` — normal (no proactive stimuli in DB yet)
- `proactive=0` — no active proactive_state rows
- `invalidated=0` — nothing stale to invalidate

If you see this line, Phase 1 Fusion Engine is working.

### Step 9: Test with a proactive stimulus (optional)

Insert a dummy stimulus for a real user to verify the Fusion Engine picks it up:

```bash
psql "$DATABASE_URL" -c "
INSERT INTO proactive_state (user_id, stimulus_type, stimulus_key, score, data)
VALUES (
  (SELECT user_id FROM users LIMIT 1),
  'weather', 'test_rain_alert', 0.85,
  '{\"condition\":\"rain\",\"area\":\"Koramangala\",\"forecast\":\"heavy rain in 2 hours\"}'
)
ON CONFLICT (user_id, stimulus_key) DO NOTHING;
"
```

Send a message from that user. Check logs for `proactive=1`:

```
[Fusion/Reactive] user=<uuid> route=respond confidence=... proactive=1 invalidated=0
```

Clean up:

```bash
psql "$DATABASE_URL" -c "DELETE FROM proactive_state WHERE stimulus_key = 'test_rain_alert';"
```

### Step 10: Enable Soul v2 (when ready)

```bash
# Edit .env
sed -i 's/SOUL_V2_ENABLED=false/SOUL_V2_ENABLED=true/' .env

# Restart (no rebuild needed, just env change)
docker compose down && docker compose up -d
```

Verify by sending a message — response tone should be more concise/social. To revert:

```bash
sed -i 's/SOUL_V2_ENABLED=true/SOUL_V2_ENABLED=false/' .env
docker compose down && docker compose up -d
```

---

## Part C: Rollback

If anything goes wrong, disable both flags:

```bash
sed -i 's/FUSION_ENGINE_ENABLED=true/FUSION_ENGINE_ENABLED=false/' .env
sed -i 's/SOUL_V2_ENABLED=true/SOUL_V2_ENABLED=false/' .env
docker compose down && docker compose up -d
```

This restores pre-fusion behavior completely. The fusion code still exists but is inactive.

---

## Quick Checklist

| # | Step | Pass? |
|---|------|-------|
| 1 | SSH + pull `dev/fusion-architecture-v2` | |
| 2 | Migration `005` runs without errors | |
| 3 | 6 tables exist in DB | |
| 4 | Fusion flags added to `.env` | |
| 5 | `docker compose build` succeeds | |
| 6 | Container starts + health check passes | |
| 7 | `[Fusion/Reactive]` log line appears on message | |
| 8 | Bot responds normally (no regressions) | |
| 9 | Proactive stimulus detected (optional) | |
| 10 | Flags off = zero fusion activity | |
