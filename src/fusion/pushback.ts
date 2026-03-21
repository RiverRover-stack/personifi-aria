/**
 * Fusion Engine — Pushback Protocol (#119)
 *
 * Handles user rejection of proactive suggestions:
 *   1st rejection → Pulse -18, retry with different angle (pivot reason)
 *   2nd rejection → Pulse -18, graceful back-off, switch to REACTIVE mode
 *   Recovery: 3 positive interactions in ENGAGED → re-enable PROACTIVE (threshold 0.85)
 */

import type { PushbackDecision, RecoveryCheck, UserContext } from './types.js'

/** Pulse delta applied per rejection (-18 from issue #119 spec) */
export const PUSHBACK_PULSE_DELTA = -18

/** Number of positive interactions needed to recover from REACTIVE-only mode */
const RECOVERY_POSITIVE_COUNT = 3

/** Softer threshold used after recovery (vs normal 0.7/0.8) */
const RECOVERY_THRESHOLD = 0.85

/**
 * Evaluate what to do after a user rejects a proactive suggestion.
 *
 * Protocol from issue #119:
 *   1st rejection → RETRY_PIVOT: try a different angle/reason
 *   2nd+ rejection → BACK_OFF: switch to REACTIVE mode, stop proactive
 */
export function evaluatePushback(rejectionCount: number): PushbackDecision {
    if (rejectionCount <= 0) {
        return {
            action: 'ALLOW',
            pulseDelta: 0,
            reason: 'No rejections — proactive allowed',
        }
    }

    if (rejectionCount === 1) {
        return {
            action: 'RETRY_PIVOT',
            pulseDelta: PUSHBACK_PULSE_DELTA,
            reason: '1st rejection — retry with different angle, Pulse -18',
        }
    }

    // 2nd+ rejection
    return {
        action: 'BACK_OFF',
        pulseDelta: PUSHBACK_PULSE_DELTA,
        reason: `${rejectionCount} rejections — graceful back-off to REACTIVE mode, Pulse -18`,
    }
}

/**
 * Check if a user in REACTIVE-only mode should recover to PROACTIVE.
 *
 * Recovery protocol from issue #119:
 *   3 positive interactions while in ENGAGED state → re-enable PROACTIVE
 *   Recovery uses softer threshold (0.85) to avoid aggressive re-engagement
 */
export function checkRecovery(userCtx: UserContext): RecoveryCheck {
    // Not in reactive-only mode — no recovery needed
    if (!userCtx.reactiveOnly) {
        return {
            shouldRecover: false,
            recoveryThreshold: 0,
            reason: 'Not in REACTIVE-only mode',
        }
    }

    // Must be in ENGAGED state to recover
    if (userCtx.pulseState !== 'ENGAGED' && userCtx.pulseState !== 'PROACTIVE') {
        return {
            shouldRecover: false,
            recoveryThreshold: 0,
            reason: `Pulse state ${userCtx.pulseState} — need ENGAGED+ to recover`,
        }
    }

    // Check positive interaction streak
    if (userCtx.positiveInteractionStreak >= RECOVERY_POSITIVE_COUNT) {
        return {
            shouldRecover: true,
            recoveryThreshold: RECOVERY_THRESHOLD,
            reason: `${userCtx.positiveInteractionStreak} positive interactions in ${userCtx.pulseState} — re-enabling PROACTIVE at threshold ${RECOVERY_THRESHOLD}`,
        }
    }

    return {
        shouldRecover: false,
        recoveryThreshold: 0,
        reason: `${userCtx.positiveInteractionStreak}/${RECOVERY_POSITIVE_COUNT} positive interactions — need more to recover`,
    }
}
