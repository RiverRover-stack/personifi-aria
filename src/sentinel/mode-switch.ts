/**
 * Sentinel Mode Switch — Phase 4 (#122)
 *
 * Implements the PROACTIVE ↔ REACTIVE mode transition rules:
 *   PROACTIVE → REACTIVE: pulse score drops below MODE_THRESHOLD (50)
 *   REACTIVE → PROACTIVE: requires 3 positive interactions + score ≥ 42.5 (softer threshold)
 *
 * Also detects the ENGAGED → CURIOUS drop that triggers a Sentinel preference re-scan.
 */

import type { SentinelUserContext, SentinelMode } from './types.js'
import type { EngagementState } from '../pulse/types.js'
import {
    MODE_THRESHOLD,
    REACTIVE_TO_PROACTIVE_POSITIVE_REQUIRED,
    RECOVERY_THRESHOLD_MULTIPLIER,
} from './constants.js'

export interface ModeSwitchResult {
    newMode: SentinelMode
    changed: boolean
    /** Set when a significant drop event requires Sentinel to re-scan preferences */
    alert?: string
}

/**
 * Evaluate whether the user's Sentinel mode should change based on current pulse.
 *
 * @param ctx             Current user context (in-memory, already loaded from DB)
 * @param previousPulseState  The pulse state from the previous tick (for drop detection)
 */
export function evaluateModeSwitch(
    ctx: SentinelUserContext,
    previousPulseState?: EngagementState,
): ModeSwitchResult {
    const { mode, pulseScore, consecutivePositive, pulseState } = ctx

    // Detect ENGAGED → CURIOUS drop (Sentinel alert: re-scan prefs for indoor/comfort stimuli)
    let alert: string | undefined
    if (previousPulseState === 'ENGAGED' && pulseState === 'CURIOUS') {
        alert = `ENGAGED → CURIOUS drop for user ${ctx.userId} — Sentinel should re-scan preferences, find indoor/comfort stimuli`
    }

    // PROACTIVE → REACTIVE: pulse drops below MODE_THRESHOLD
    if (mode === 'PROACTIVE' && pulseScore < MODE_THRESHOLD) {
        return { newMode: 'REACTIVE', changed: true, alert }
    }

    // REACTIVE → PROACTIVE: recovery requires 3 positive interactions + softer threshold (42.5)
    if (mode === 'REACTIVE') {
        const softThreshold = MODE_THRESHOLD * RECOVERY_THRESHOLD_MULTIPLIER
        if (
            consecutivePositive >= REACTIVE_TO_PROACTIVE_POSITIVE_REQUIRED &&
            pulseScore >= softThreshold
        ) {
            return { newMode: 'PROACTIVE', changed: true, alert }
        }
        return { newMode: 'REACTIVE', changed: false, alert }
    }

    return { newMode: mode, changed: false, alert }
}

/** Update in-memory context to record a positive interaction (call DB writer separately) */
export function recordPositiveInteraction(ctx: SentinelUserContext): void {
    ctx.consecutivePositive++
}

/** Update in-memory context to record a pushback (call DB writer separately) */
export function recordPushback(ctx: SentinelUserContext): void {
    ctx.pushbackCount++
    ctx.consecutivePositive = 0
}
