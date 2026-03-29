/**
 * Sentinel Types — Phase 4 (#121, #122)
 *
 * Core types for the background intelligence loop that powers
 * proactive behavior — the Sentinel.
 */

import type { EngagementState } from '../pulse/types.js'
import type { ProactiveAction, StimulusInput } from '../fusion/types.js'

export type SentinelMode = 'PROACTIVE' | 'REACTIVE'

/** Which stimulus collector produced this stimulus */
export type StimulusCategory =
    | 'stimulus_refresh'   // weather/traffic/festival — was */30m cron × 3
    | 'social_monitor'     // squad convergence, friend changes — was */15m + */30m crons
    | 'topic_followup'     // warm topic re-engagement — was */30m cron
    | 'content_scan'       // trending + relevant content — was */2h + */6h crons
    | 'memory_process'     // queued memory writes (maintenance) — was */30s cron
    | 'session_cleanup'    // summarize + trim (maintenance) — was */5m cron
    | 'mess_menu'          // hostel meal stimulus — Phase 5, Issue #135
    | 'local_event'        // nearby events in next 3 days — Phase 5, Issue #135

/** Per-user context loaded at the start of each Sentinel tick */
export interface SentinelUserContext {
    userId: string
    /** Telegram chat ID for delivery */
    chatId: string
    /** User display name (for Alpha proactive generation) */
    displayName: string | null
    pulseState: EngagementState
    pulseScore: number
    mode: SentinelMode
    /** Number of proactive messages sent today */
    dailyFireCount: number
    /** Epoch ms of last FIRE */
    lastFireAt: number
    /** YYYY-MM-DD IST — for daily reset detection */
    lastResetDate: string
    pushbackCount: number
    consecutivePositive: number
    preferences: Record<string, string>
    /**
     * Epoch ms of the user's most recent message.
     * Used to detect active sessions: do NOT FIRE if user messaged within 10 minutes.
     * Loaded from sessions.last_active JOIN.
     */
    lastActiveAt: number
}

/** A stimulus that has been scored against user context */
export interface ScoredStimulus {
    userId: string
    category: StimulusCategory
    stimulus: StimulusInput
    /** Fusion composite score (0–1) */
    compositeScore: number
    /** Social overlay boost (1.0 = no boost, 1.3 = squad convergence) */
    socialBoost: number
}

/** A decision produced by the Sentinel decision engine */
export interface SentinelDecision {
    action: ProactiveAction | 'PRE_FETCH'
    stimulus: ScoredStimulus
    reason: string
    pulseDelta: number
}

/** Summary of one Sentinel tick — useful for monitoring */
export interface SentinelTickResult {
    startedAt: Date
    finishedAt: Date
    usersProcessed: number
    fires: number
    buffers: number
    drops: number
    preFetches: number
    errors: number
}
