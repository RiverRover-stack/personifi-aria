/**
 * Sentinel Constants — Phase 4 (#121, #122)
 *
 * All thresholds, limits, and intervals in one place so they can be
 * tuned without touching business logic.
 */

/** Main event loop interval — one tick = 60 seconds */
export const SENTINEL_TICK_INTERVAL_MS = 60_000

/** Proactive messages are only sent between 8am–10pm IST */
export const ACTIVE_HOURS = { start: 8, end: 22 }

/** Max proactive fires per day when Pulse is in default (non-PROACTIVE) state */
export const DAILY_FIRE_LIMIT_DEFAULT = 3

/** Max proactive fires per day when Pulse state is PROACTIVE (score ≥ 80) */
export const DAILY_FIRE_LIMIT_PROACTIVE = 5

/** Minimum time between two FIREs for the same user — 25 minutes */
export const MIN_FIRE_COOLDOWN_MS = 25 * 60_000

/** Pulse score threshold: ≥ 50 → PROACTIVE mode, < 50 → REACTIVE mode */
export const MODE_THRESHOLD = 50

/** How many consecutive positive interactions required for REACTIVE → PROACTIVE recovery */
export const REACTIVE_TO_PROACTIVE_POSITIVE_REQUIRED = 3

/** Recovery uses a softer threshold: MODE_THRESHOLD × 0.85 = 42.5 */
export const RECOVERY_THRESHOLD_MULTIPLIER = 0.85

/** Buffered stimuli expire after this many hours */
export const BUFFER_EXPIRY_HOURS = 24

/** Max concurrent users processed per batch (controls parallelism) */
export const USER_BATCH_SIZE = 10

/** Score boost when 3+ friends are interested in the same topic */
export const SOCIAL_CONVERGENCE_BOOST = 1.3

/** Additional boost when an active squad discussion is happening */
export const SOCIAL_SQUAD_BOOST = 0.10

/**
 * How often each collector runs, expressed in ticks (1 tick = 60s).
 * These replace the 12 individual cron jobs that were in scheduler.ts.
 */
export const COLLECTOR_INTERVALS: Record<string, number> = {
    stimulus_refresh: 30,   // was */30m cron — runs every 30 ticks
    social_monitor:   15,   // was */15m cron — runs every 15 ticks
    topic_followup:   30,   // was */30m cron — runs every 30 ticks
    content_scan:    120,   // was */2h  cron — runs every 120 ticks
    memory_process:    1,   // was */30s cron — runs every tick
    session_cleanup:   5,   // was */5m  cron — runs every 5 ticks
    mess_menu:        30,   // Phase 5: hostel meal windows change per meal bucket — every 30 ticks
    local_event:      60,   // Phase 5: upcoming events (next 3 days) — hourly check
    plan_reminder:    10,   // Phase 2: plan reminders — every 10 ticks (~10 minutes)
    interest_intent:  10,   // Phase 2: interest intents — every 10 ticks (~10 minutes)
    session_pruner: 10080,  // Weekly digest + prune — every 10080 ticks (7 days × 24h × 60m)
}
