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

    // REACTIVE → PROACTIVE: two recovery paths
    //
    // Path A (standard): 3+ positive proactive interactions + score ≥ 42.5
    //   Used when the user has been engaging with proactive messages.
    //
    // Path B (pulse-based, anti-deadlock): pulse score ≥ 75 AND pulse state ENGAGED+
    //   Used when the user is actively and happily chatting (reactive conversations
    //   push pulse up) but consecutive_positive is stuck at 0 because REACTIVE mode
    //   prevents FIRE — which prevents recordPositiveInteractionDB from being called.
    //   Without Path B, recovery is mathematically impossible once stuck in REACTIVE.
    if (mode === 'REACTIVE') {
        const softThreshold = MODE_THRESHOLD * RECOVERY_THRESHOLD_MULTIPLIER  // 42.5

        // Path A: traditional positive streak recovery
        if (
            consecutivePositive >= REACTIVE_TO_PROACTIVE_POSITIVE_REQUIRED &&
            pulseScore >= softThreshold
        ) {
            return {
                newMode: 'PROACTIVE',
                changed: true,
                alert:   `Recovery (Path A): ${consecutivePositive} positive interactions, score=${pulseScore}`,
            }
        }

        // Path B: high pulse score indicates healthy engagement — auto-recover
        // Threshold: score ≥ 75 (ENGAGED state starts around 50, PROACTIVE at 80).
        // Only applies when the user is demonstrably active (ENGAGED or PROACTIVE pulse).
        const pulseBasedRecovery =
            pulseScore >= 75 &&
            (pulseState === 'ENGAGED' || pulseState === 'PROACTIVE') &&
            ctx.pushbackCount === 0  // don't recover if there are outstanding pushbacks

        if (pulseBasedRecovery) {
            return {
                newMode: 'PROACTIVE',
                changed: true,
                alert:   `Recovery (Path B): pulse=${pulseScore} ${pulseState} with no pushbacks — auto-recovering from REACTIVE`,
            }
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
