/**
 * Fusion Engine — Proactive Mode (#119)
 *
 * Evaluates a stimulus against user context and mode thresholds.
 * Decision: FIRE (send now) / BUFFER (save for later) / DROP (discard)
 *
 * Threshold logic (from issue #119):
 *   score >= threshold → FIRE
 *   0.6 <= score < threshold → BUFFER
 *   score < 0.6 → DROP
 *
 * Pushback protocol:
 *   1st rejection → retry different angle (Pulse -18)
 *   2nd rejection → back off to REACTIVE mode (Pulse -18)
 *   Recovery: 3 positive in ENGAGED → PROACTIVE at 0.85
 */

import type { StimulusInput, UserContext, ProactiveDecision } from './types.js'
import { computeFusionScore } from './scoring.js'
import { getFusionMode } from './mode-switch.js'
import { evaluatePushback, checkRecovery, PUSHBACK_PULSE_DELTA } from './pushback.js'

/**
 * Evaluate a stimulus and decide whether to FIRE, BUFFER, or DROP.
 */
export function fusionProactiveDecision(
    stimulus: StimulusInput,
    userCtx: UserContext,
    now: Date = new Date(),
): ProactiveDecision {
    const score = computeFusionScore(stimulus, userCtx)
    const mode = getFusionMode(userCtx.pulseState)

    // Pushback protocol: check rejection history
    const pushback = evaluatePushback(userCtx.recentPushbacks)
    if (pushback.action === 'BACK_OFF') {
        return {
            action: 'DROP',
            score,
            reason: pushback.reason,
            stimulus,
            pulseDelta: pushback.pulseDelta,
        }
    }
    if (pushback.action === 'RETRY_PIVOT') {
        // 1st rejection: still allow FIRE but with reduced threshold and a pivot note
        // Score must be even higher to justify retry
        const retryThreshold = Math.min(mode.threshold + 0.1, 0.95)
        if (score >= retryThreshold) {
            return {
                action: 'FIRE',
                score,
                reason: `Retry pivot: score ${score.toFixed(2)} >= retry threshold ${retryThreshold} — try different angle`,
                stimulus,
                pulseDelta: 0, // no additional delta on fire, the -18 was already applied on rejection
            }
        }
        return {
            action: 'BUFFER',
            score,
            reason: `Retry pivot: score ${score.toFixed(2)} < retry threshold ${retryThreshold} — buffering for better moment`,
            stimulus,
            pulseDelta: 0,
        }
    }

    // REACTIVE-only mode: check recovery
    if (userCtx.reactiveOnly) {
        const recovery = checkRecovery(userCtx)
        if (recovery.shouldRecover) {
            // Recovered! Use softer threshold
            if (score >= recovery.recoveryThreshold) {
                return {
                    action: 'FIRE',
                    score,
                    reason: `Recovery: ${recovery.reason} — score ${score.toFixed(2)} >= ${recovery.recoveryThreshold}`,
                    stimulus,
                    pulseDelta: 0,
                }
            }
            return {
                action: 'BUFFER',
                score,
                reason: `Recovery: score ${score.toFixed(2)} < recovery threshold ${recovery.recoveryThreshold}`,
                stimulus,
                pulseDelta: 0,
            }
        }
        // Still in reactive-only, not recovered — only BUFFER, never FIRE
        return {
            action: 'BUFFER',
            score,
            reason: `REACTIVE-only mode: ${recovery.reason} — buffering, no proactive fire`,
            stimulus,
            pulseDelta: 0,
        }
    }

    // Time window check: only fire proactive messages 8am-10pm IST
    // Correct IST conversion: total UTC minutes + 330 (5h30m offset), mod 1440, then divide to get float hour
    const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440
    const istHour = istMinutes / 60
    if (istHour < 8 || istHour >= 22) {
        if (score >= mode.threshold) {
            return {
                action: 'BUFFER',
                score,
                reason: `Outside active window (${Math.floor(istHour)}h IST) — buffering for morning`,
                stimulus,
                pulseDelta: 0,
            }
        }
        return {
            action: 'DROP',
            score,
            reason: `Outside active window and score ${score.toFixed(2)} below threshold ${mode.threshold}`,
            stimulus,
            pulseDelta: 0,
        }
    }

    // FIRE: score meets threshold
    if (score >= mode.threshold) {
        return {
            action: 'FIRE',
            score,
            reason: `Score ${score.toFixed(2)} >= threshold ${mode.threshold} in ${mode.mode} mode`,
            stimulus,
            pulseDelta: 0,
        }
    }

    // BUFFER: score is in the buffer zone (threshold - 0.2 to threshold)
    if (score >= mode.threshold - 0.2) {
        return {
            action: 'BUFFER',
            score,
            reason: `Score ${score.toFixed(2)} within buffer range (${(mode.threshold - 0.2).toFixed(2)}-${mode.threshold}) in ${mode.mode} mode`,
            stimulus,
            pulseDelta: 0,
        }
    }

    // DROP: score too low
    return {
        action: 'DROP',
        score,
        reason: `Score ${score.toFixed(2)} below buffer range in ${mode.mode} mode`,
        stimulus,
        pulseDelta: 0,
    }
}
