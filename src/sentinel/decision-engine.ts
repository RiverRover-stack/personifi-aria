/**
 * Sentinel Decision Engine — Phase 4 (#121)
 *
 * Takes scored stimuli + user context and produces FIRE / BUFFER / DROP decisions.
 *
 * Decision gates (checked in order):
 *   1. Active hours (8am–10pm IST) — outside window: BUFFER if score ≥ 0.6, DROP otherwise
 *   2. Daily fire limit — at limit: DROP
 *   3. Cooldown — too soon after last FIRE: BUFFER
 *   4. Mode check — REACTIVE mode: BUFFER (never FIRE)
 *   5. Fusion proactive decision — delegates threshold logic to fusion engine
 *   6. Only one FIRE per tick — second FIRE → BUFFER
 */

import type { SentinelUserContext, ScoredStimulus, SentinelDecision } from './types.js'
import type { UserContext } from '../fusion/types.js'
import {
    ACTIVE_HOURS,
    DAILY_FIRE_LIMIT_DEFAULT,
    DAILY_FIRE_LIMIT_PROACTIVE,
    MIN_FIRE_COOLDOWN_MS,
} from './constants.js'
import { fusionProactiveDecision } from '../fusion/proactive.js'

/**
 * Produce a decision for each stimulus, sorted by score (highest first).
 */
export function decideSentinelActions(
    stimuli: ScoredStimulus[],
    ctx: SentinelUserContext,
): SentinelDecision[] {
    const decisions: SentinelDecision[] = []
    const sorted = [...stimuli].sort((a, b) => b.compositeScore - a.compositeScore)
    let firedThisTick = false

    for (const stimulus of sorted) {
        // ── Gate 1: Active hours ──────────────────────────────────────────────
        if (!isWithinActiveHours()) {
            decisions.push(
                stimulus.compositeScore >= 0.6
                    ? { action: 'BUFFER', stimulus, reason: 'Outside active hours (8am–10pm IST) — buffered for morning', pulseDelta: 0 }
                    : { action: 'DROP',   stimulus, reason: 'Outside active hours and score below buffer threshold',       pulseDelta: 0 },
            )
            continue
        }

        // ── Gate 2: Daily fire limit ──────────────────────────────────────────
        const limit = ctx.pulseState === 'PROACTIVE' ? DAILY_FIRE_LIMIT_PROACTIVE : DAILY_FIRE_LIMIT_DEFAULT
        if (ctx.dailyFireCount >= limit) {
            decisions.push({
                action: 'DROP',
                stimulus,
                reason: `Daily fire limit reached (${ctx.dailyFireCount}/${limit})`,
                pulseDelta: 0,
            })
            continue
        }

        // ── Gate 3: Cooldown ──────────────────────────────────────────────────
        if (ctx.lastFireAt > 0 && Date.now() - ctx.lastFireAt < MIN_FIRE_COOLDOWN_MS) {
            const minLeft = Math.ceil((MIN_FIRE_COOLDOWN_MS - (Date.now() - ctx.lastFireAt)) / 60_000)
            decisions.push({
                action: 'BUFFER',
                stimulus,
                reason: `Cooldown not elapsed (${minLeft}m remaining)`,
                pulseDelta: 0,
            })
            continue
        }

        // ── Gate 4: Mode check — REACTIVE mode never fires ───────────────────
        if (ctx.mode === 'REACTIVE') {
            decisions.push({
                action: 'BUFFER',
                stimulus,
                reason: 'REACTIVE mode — only buffering, not firing',
                pulseDelta: 0,
            })
            continue
        }

        // ── Gate 5: Fusion proactive decision ────────────────────────────────
        const userCtx: UserContext = {
            userId:                    ctx.userId,
            pulseState:                ctx.pulseState,
            pulseScore:                ctx.pulseScore,
            preferences:               ctx.preferences,
            recentPushbacks:           ctx.pushbackCount,
            proactiveCountToday:       ctx.dailyFireCount,
            positiveInteractionStreak: ctx.consecutivePositive,
            reactiveOnly:              false, // Gate 4 above already handled REACTIVE mode
        }
        const fusionDecision = fusionProactiveDecision(stimulus.stimulus, userCtx)

        // ── Gate 6: One FIRE per tick ─────────────────────────────────────────
        if (fusionDecision.action === 'FIRE') {
            if (!firedThisTick) {
                firedThisTick = true
                decisions.push({
                    action:     'FIRE',
                    stimulus,
                    reason:     fusionDecision.reason,
                    pulseDelta: fusionDecision.pulseDelta,
                })
            } else {
                decisions.push({
                    action:     'BUFFER',
                    stimulus,
                    reason:     'Already fired once this tick — buffered',
                    pulseDelta: 0,
                })
            }
        } else {
            decisions.push({
                action:     fusionDecision.action,
                stimulus,
                reason:     fusionDecision.reason,
                pulseDelta: fusionDecision.pulseDelta,
            })
        }
    }

    return decisions
}

/** Check if the current time is within 8am–10pm IST */
export function isWithinActiveHours(): boolean {
    const now = new Date()
    const totalMinutesUTC = now.getUTCHours() * 60 + now.getUTCMinutes()
    // IST = UTC + 5:30 = UTC + 330 minutes
    const istMinutes = (totalMinutesUTC + 330) % (24 * 60)
    const istHour = istMinutes / 60
    return istHour >= ACTIVE_HOURS.start && istHour < ACTIVE_HOURS.end
}
