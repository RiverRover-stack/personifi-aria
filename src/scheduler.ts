/**
 * Scheduler – Health heartbeat + proactive content pipeline
 *
 * Proactive pipeline runs every 10 minutes:
 *   contentIntelligence → 70B proactive agent → reelPipeline → Telegram
 *
 * The proactive runner handles its own gate checks:
 *   - Time windows (8am–10pm IST)
 *   - Daily limits (max 2 per day per user)
 *   - Cooldowns (min 25 min between sends)
 *   - 70B decision (random gap behavior)
 */

import { logger } from './logger.js'
import { registerMediaCron } from './cron/media-cron.js'
import { runMigrations } from './character/session-store.js'
import { startSentinel } from './sentinel/index.js'

const log = logger.child({ module: 'scheduler' })

// ─── Core scheduler ────────────────────────────────────────────────────────
//
// Phase 4 (#121): The 12 individual cron jobs have been replaced by the
// Sentinel background loop — a single 60-second event-driven tick that handles
// all per-user stimulus collection, scoring, and delivery in one place.
//
// Preserved from old scheduler:
//   - Health heartbeat (30s)
//   - Media cron (6h) — registered via registerMediaCron()
//   - Startup: migrations + user loading (8s delay)
//
// Replaced by Sentinel:
//   - Topic follow-ups (*/30m)        → COLLECTOR_INTERVALS.topic_followup
//   - Content blast (*/2h)            → COLLECTOR_INTERVALS.content_scan
//   - Social outbound (*/15m)         → COLLECTOR_INTERVALS.social_monitor
//   - Rate limit cleanup (*/1h)       → runSessionCleanup() every 5 ticks
//   - Stale topic sweep (*/1h)        → runSessionCleanup() every 5 ticks
//   - Price alert checks (*/30m)      → COLLECTOR_INTERVALS.stimulus_refresh
//   - Stimulus refresh (*/30m)        → COLLECTOR_INTERVALS.stimulus_refresh
//   - Intelligence cron (*/2h)        → COLLECTOR_INTERVALS.content_scan
//   - Friend bridge (*/30m)           → COLLECTOR_INTERVALS.social_monitor
//   - Memory write queue (*/30s)      → COLLECTOR_INTERVALS.memory_process (every tick)
//   - Session summarization (*/5m)    → COLLECTOR_INTERVALS.session_cleanup

export function initScheduler(_databaseUrl: string) {
  // ── 1. Health heartbeat — every 30 seconds ──────────────────────────────
  setInterval(() => {
    log.info('Heartbeat')
  }, 30_000)

  // ── 2. Media scraping cron — every 6 hours (unchanged) ────────────────
  registerMediaCron()

  // ── 3. Startup: migrations + user loading + Sentinel ──────────────────
  setTimeout(async () => {
    try {
      await runMigrations()
      startSentinel()
    } catch (err) {
      log.error({ err }, 'Startup DB tasks failed')
    }
  }, 8000) // after DB pool is ready

  log.info('Scheduler initialized — heartbeat (30s) + Sentinel background loop (60s tick)')
}
