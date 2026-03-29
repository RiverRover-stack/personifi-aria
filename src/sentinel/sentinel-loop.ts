/**
 * Sentinel Background Loop — Phase 4 (#121)
 *
 * Single event-driven loop that replaces 12 cron jobs in scheduler.ts.
 *
 * Every 60-second tick:
 *   1. Maintenance phase: memory process, session cleanup, stimulus refresh
 *      (throttled by tick counters so each runs at its original interval)
 *   2. User phase: for each active user, collect stimuli → score → overlay → decide → execute
 *
 * Actions:
 *   FIRE     → write ProactiveState + send Telegram message immediately
 *   BUFFER   → write ProactiveState only (Alpha picks up on next user message)
 *   DROP     → log for analytics, discard
 *   PRE_FETCH→ call tool API, cache in tool_results, then FIRE/BUFFER (future)
 */

import { getPool } from '../character/session-store.js'
import {
    loadSentinelUsersWithContext,
    incrementDailyFire,
    resetDailyCountsIfNeeded,
    saveSentinelMode,
    recordPushbackDB,
    recordPositiveInteractionDB,
} from './state-store.js'
import {
    collectStimulusRefresh,
    collectSocialMonitor,
    collectTopicFollowup,
    collectContentScan,
    collectMessMenu,
    collectLocalEvents,
    collectPlanReminders,
    collectInterestIntents,
    runMemoryProcess,
    runSessionCleanup,
    runSessionPruner,
} from './collectors.js'
import { applySocialOverlay } from './social-overlay.js'
import { decideSentinelActions } from './decision-engine.js'
import { evaluateModeSwitch } from './mode-switch.js'
import { executeFire, executeBuffer } from './delivery.js'
import { computeFusionScore } from '../fusion/scoring.js'
import { refreshAllStimuliForActiveLocations } from '../stimulus/stimulus-router.js'
import { runFusionTableCleanup } from '../db/fusion-tables.js'
import { logger } from '../logger.js'
import type { SentinelTickResult, ScoredStimulus, SentinelUserContext, StimulusCategory } from './types.js'
import type { StimulusInput } from '../fusion/types.js'
import { SENTINEL_TICK_INTERVAL_MS, USER_BATCH_SIZE, COLLECTOR_INTERVALS } from './constants.js'
import type { Pool } from 'pg'

const log = logger.child({ module: 'sentinel' })

let tickCount = 0
let intervalHandle: ReturnType<typeof setInterval> | null = null

/**
 * In-memory map of each user's pulse state from the PREVIOUS tick.
 * Used to detect state transitions (e.g. ENGAGED → CURIOUS) for alerts.
 * Single-process safe; resets on restart (acceptable — only used for alerting).
 */
const previousPulseStates = new Map<string, import('../pulse/types.js').EngagementState>()

/** Current date in IST (YYYY-MM-DD) for daily reset checks */
function getCurrentDateIST(): string {
    const now = new Date()
    const ist = new Date(now.getTime() + 330 * 60 * 1000) // +5:30
    return ist.toISOString().split('T')[0]
}

// ─── Main tick ────────────────────────────────────────────────────────────────

export async function sentinelTick(): Promise<SentinelTickResult> {
    const result: SentinelTickResult = {
        startedAt:      new Date(),
        finishedAt:     new Date(),
        usersProcessed: 0,
        fires:          0,
        buffers:        0,
        drops:          0,
        preFetches:     0,
        errors:         0,
    }

    tickCount++
    const pool = getPool()

    try {
        // ── Maintenance phase (not per-user) ──────────────────────────────────
        if (tickCount % COLLECTOR_INTERVALS.memory_process === 0) {
            await runMemoryProcess().catch(err => log.error({ err }, 'Memory process error'))
        }
        if (tickCount % COLLECTOR_INTERVALS.session_cleanup === 0) {
            await runSessionCleanup().catch(err => log.error({ err }, 'Session cleanup error'))
        }
        if (tickCount % COLLECTOR_INTERVALS.stimulus_refresh === 0) {
            await refreshAllStimuliForActiveLocations().catch(err => log.error({ err }, 'Stimulus refresh error'))
        }
        // Fusion table cleanup: hourly (every 60 ticks)
        if (tickCount % 60 === 0) {
            await runFusionTableCleanup(pool).catch(err => log.error({ err }, 'Fusion table cleanup error'))
        }
        // Weekly digest compilation + session prune (every 10080 ticks = 7 days)
        if (tickCount % COLLECTOR_INTERVALS.session_pruner === 0) {
            await runSessionPruner().catch(err => log.error({ err }, 'Session pruner error'))
        }

        // ── User phase ────────────────────────────────────────────────────────
        const users = await loadSentinelUsersWithContext(pool)

        // Process users in batches for controlled parallelism
        for (let i = 0; i < users.length; i += USER_BATCH_SIZE) {
            const batch = users.slice(i, i + USER_BATCH_SIZE)
            const batchResults = await Promise.allSettled(
                batch.map(ctx => processUser(ctx, pool, result))
            )
            for (const r of batchResults) {
                if (r.status === 'rejected') {
                    result.errors++
                    log.error({ err: r.reason }, 'User processing failed in batch')
                }
            }
        }

        log.info(
            { tick: tickCount, users: result.usersProcessed, fires: result.fires, buffers: result.buffers, drops: result.drops, errors: result.errors },
            'Sentinel tick complete'
        )
    } catch (err) {
        log.error({ err }, 'Sentinel tick top-level error')
        result.errors++
    }

    result.finishedAt = new Date()
    return result
}

// ─── Per-user processing ──────────────────────────────────────────────────────

async function processUser(ctx: SentinelUserContext, pool: Pool, result: SentinelTickResult): Promise<void> {
    // 1. Reset daily counts if new IST day
    await resetDailyCountsIfNeeded(pool, ctx.userId, getCurrentDateIST())

    // 2. Evaluate mode switch (PROACTIVE ↔ REACTIVE)
    // Pass the previous tick's pulse state so ENGAGED→CURIOUS drops are detected.
    const prevPulseState = previousPulseStates.get(ctx.userId)
    const modeResult = evaluateModeSwitch(ctx, prevPulseState)
    previousPulseStates.set(ctx.userId, ctx.pulseState)
    if (modeResult.changed) {
        ctx.mode = modeResult.newMode
        await saveSentinelMode(pool, ctx.userId, modeResult.newMode)
        log.info({ userId: ctx.userId, newMode: modeResult.newMode }, 'Sentinel mode switch')
    }
    if (modeResult.alert) {
        log.warn({ userId: ctx.userId, alert: modeResult.alert }, 'Sentinel alert')
    }

    // 3. Collect stimuli (only categories due this tick)
    const stimuli: ScoredStimulus[] = []

    const collectorMap: Array<{
        key: string
        category: StimulusCategory
        fn: (id: string) => Promise<StimulusInput[]>
    }> = [
        { key: 'stimulus_refresh', category: 'stimulus_refresh', fn: collectStimulusRefresh },
        { key: 'social_monitor',   category: 'social_monitor',   fn: collectSocialMonitor },
        { key: 'topic_followup',   category: 'topic_followup',   fn: collectTopicFollowup },
        { key: 'content_scan',     category: 'content_scan',     fn: collectContentScan },
        { key: 'mess_menu',        category: 'mess_menu',        fn: collectMessMenu },
        { key: 'local_event',      category: 'local_event',      fn: collectLocalEvents },
        { key: 'plan_reminder',    category: 'topic_followup',   fn: collectPlanReminders },
        { key: 'interest_intent',  category: 'topic_followup',   fn: collectInterestIntents },
    ]

    for (const { key, category, fn } of collectorMap) {
        if (tickCount % COLLECTOR_INTERVALS[key] === 0) {
            try {
                const raw = await fn(ctx.userId)
                for (const s of raw) {
                    const score = computeFusionScore(s, {
                        userId:                    ctx.userId,
                        pulseState:                ctx.pulseState,
                        pulseScore:                ctx.pulseScore,
                        preferences:               ctx.preferences,
                        recentPushbacks:           ctx.pushbackCount,
                        proactiveCountToday:       ctx.dailyFireCount,
                        positiveInteractionStreak: ctx.consecutivePositive,
                        reactiveOnly:              ctx.mode === 'REACTIVE',
                    })
                    stimuli.push({
                        userId:         ctx.userId,
                        category,
                        stimulus:       s,
                        compositeScore: score,
                        socialBoost:    1.0,
                    })
                }
            } catch (err) {
                log.error({ err, userId: ctx.userId, category }, 'Collector error')
            }
        }
    }

    // 4. Apply social overlay (squad convergence boost)
    for (let i = 0; i < stimuli.length; i++) {
        stimuli[i] = await applySocialOverlay(stimuli[i])
    }

    // 5. Decide actions
    const decisions = decideSentinelActions(stimuli, ctx)

    // 6. Execute decisions and persist engagement state changes
    for (const decision of decisions) {
        switch (decision.action) {
            case 'FIRE': {
                const sent = await executeFire(decision.stimulus, ctx).catch(() => false)
                if (sent) {
                    await incrementDailyFire(pool, ctx.userId)
                    ctx.dailyFireCount++
                    ctx.lastFireAt = Date.now()
                    result.fires++
                }
                break
            }
            case 'BUFFER':
                await executeBuffer(decision.stimulus, ctx).catch(err =>
                    log.error({ err, userId: ctx.userId }, 'Buffer write error')
                )
                result.buffers++
                break
            case 'DROP':
                result.drops++
                break
            case 'PRE_FETCH':
                result.preFetches++
                break
        }

        // Persist engagement state from this decision (fire-and-forget).
        //
        // Pushback recording:
        //   Only counts when a proactive decision was DROPPED due to BACK_OFF
        //   (pulseDelta < 0 means fusion returned BACK_OFF for 2+ rejections).
        //   The first pushback is recorded directly from handler.ts when the user
        //   rejects a proactive message mid-conversation.
        //
        // Positive interaction recording:
        //   Counts when Sentinel successfully FIREs a proactive message.
        //   Also counts when user's pulse is ENGAGED+ and they messaged recently
        //   (this breaks the REACTIVE-mode deadlock where FIRE never happens).
        if (decision.pulseDelta < 0) {
            recordPushbackDB(pool, ctx.userId).catch(err =>
                log.error({ err, userId: ctx.userId }, 'Failed to persist pushback')
            )
        } else if (decision.action === 'FIRE') {
            recordPositiveInteractionDB(pool, ctx.userId).catch(err =>
                log.error({ err, userId: ctx.userId }, 'Failed to persist positive interaction from FIRE')
            )
        }
    }

    // ── Anti-deadlock: record positive interaction from reactive chat ─────────
    // In REACTIVE sentinel mode, FIRE never happens so recordPositiveInteractionDB
    // is never called from the decisions loop above. This means consecutivePositive
    // can never grow and recovery to PROACTIVE mode is impossible.
    //
    // Fix: if the user has been actively chatting (message within last 30 min)
    // AND their pulse score is healthy (ENGAGED+), count that as a positive
    // interaction — they're engaging with Aria even if not via proactive messages.
    // Capped to run at most once per 5 ticks (5 min) per user to avoid over-counting.
    if (
        ctx.mode === 'REACTIVE' &&
        ctx.lastActiveAt > 0 &&
        Date.now() - ctx.lastActiveAt < 30 * 60 * 1000 &&  // active within 30 min
        (ctx.pulseState === 'ENGAGED' || ctx.pulseState === 'PROACTIVE') &&
        tickCount % 5 === 0  // once per 5-min window
    ) {
        ctx.consecutivePositive++
        recordPositiveInteractionDB(pool, ctx.userId).catch(err =>
            log.error({ err, userId: ctx.userId }, 'Failed to persist reactive positive interaction')
        )
        log.debug(
            { userId: ctx.userId, streak: ctx.consecutivePositive, pulse: ctx.pulseState },
            'Reactive chat positive interaction recorded (anti-deadlock)',
        )
    }

    result.usersProcessed++
}

// ─── Start / stop ─────────────────────────────────────────────────────────────

export function startSentinel(): void {
    if (intervalHandle) return
    log.info('Sentinel background loop starting (60s tick)')
    intervalHandle = setInterval(() => {
        sentinelTick().catch(err => log.error({ err }, 'Unhandled Sentinel tick error'))
    }, SENTINEL_TICK_INTERVAL_MS)
}

export function stopSentinel(): void {
    if (!intervalHandle) return
    clearInterval(intervalHandle)
    intervalHandle = null
    log.info('Sentinel background loop stopped')
}
