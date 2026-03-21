import { describe, it, expect } from 'vitest'
import {
    computeFusionScore,
    getStimulusWeight,
    getReceptivity,
    prefMatch,
    computeFatigue,
    getFusionMode,
    evaluatePushback,
    checkRecovery,
    PUSHBACK_PULSE_DELTA,
} from './index.js'
import { fusionProactiveDecision } from './proactive.js'
import type { StimulusInput, UserContext } from './types.js'

// ─── Scoring Tests ──────────────────────────────────────────────────────────

describe('getStimulusWeight', () => {
    it('returns correct weights for known types', () => {
        expect(getStimulusWeight('weather')).toBe(0.9)
        expect(getStimulusWeight('traffic')).toBe(0.85)
        expect(getStimulusWeight('social')).toBe(0.7)
        expect(getStimulusWeight('event')).toBe(0.6)
        expect(getStimulusWeight('food')).toBe(0.5)
        expect(getStimulusWeight('price')).toBe(0.4)
    })

    it('returns 0.3 for unknown types', () => {
        expect(getStimulusWeight('unknown')).toBe(0.3)
    })
})

describe('getReceptivity', () => {
    it('returns correct receptivity for each state', () => {
        expect(getReceptivity('PROACTIVE')).toBe(1.0)
        expect(getReceptivity('ENGAGED')).toBe(0.8)
        expect(getReceptivity('CURIOUS')).toBe(0.5)
        expect(getReceptivity('PASSIVE')).toBe(0.2)
    })
})

describe('prefMatch', () => {
    const stimulus: StimulusInput = {
        type: 'food',
        key: 'biryani_deal_koramangala',
        weight: 0.5,
        data: { item: 'biryani', area: 'Koramangala' },
    }

    it('returns 1.0 for exact value match in data', () => {
        const prefs = { cuisine: 'biryani' }
        expect(prefMatch(prefs, stimulus)).toBe(1.0)
    })

    it('returns 0.7 for category match', () => {
        const prefs = { food_style: 'spicy' }
        expect(prefMatch(prefs, stimulus)).toBe(0.7)
    })

    it('returns 0.3 when no preferences', () => {
        expect(prefMatch({}, stimulus)).toBe(0.3)
    })

    it('returns 0.3 when preferences do not match', () => {
        const prefs = { transport: 'metro' }
        expect(prefMatch(prefs, stimulus)).toBe(0.3)
    })
})

describe('computeFatigue', () => {
    it('returns 0 when no proactive messages sent', () => {
        expect(computeFatigue(0, 5)).toBe(0)
    })

    it('returns correct ratio', () => {
        expect(computeFatigue(2, 5)).toBeCloseTo(0.4)
    })

    it('caps at 1.0', () => {
        expect(computeFatigue(10, 5)).toBe(1.0)
    })

    it('returns 1.0 when max is 0', () => {
        expect(computeFatigue(1, 0)).toBe(1.0)
    })
})

describe('computeFusionScore', () => {
    const stimulus: StimulusInput = {
        type: 'weather',
        key: 'rain_commute',
        weight: 0.9,
        data: { condition: 'rain' },
    }

    const baseCtx: UserContext = {
        userId: 'test',
        pulseState: 'PROACTIVE',
        pulseScore: 85,
        preferences: { weather_pref: 'rain' },
        recentPushbacks: 0,
        proactiveCountToday: 0,
        positiveInteractionStreak: 0,
        reactiveOnly: false,
    }

    it('returns high score for PROACTIVE user with matching preferences', () => {
        const score = computeFusionScore(stimulus, baseCtx)
        // 0.9 * 1.0 * 1.0 * (1 - 0) = 0.9
        expect(score).toBe(0.9)
    })

    it('returns low score for PASSIVE user with no preferences', () => {
        const ctx: UserContext = { ...baseCtx, pulseState: 'PASSIVE', pulseScore: 10, preferences: {} }
        const score = computeFusionScore(stimulus, ctx)
        // 0.9 * 0.3 * 0.2 * (1 - 0) = 0.054
        expect(score).toBeCloseTo(0.054)
    })

    it('reduces score when fatigued', () => {
        const ctx: UserContext = { ...baseCtx, proactiveCountToday: 4 }
        const score = computeFusionScore(stimulus, ctx)
        // 0.9 * 1.0 * 1.0 * (1 - 4/5) = 0.9 * 0.2 = 0.18
        expect(score).toBeCloseTo(0.18)
    })

    it('returns 0 when fully fatigued', () => {
        const ctx: UserContext = { ...baseCtx, preferences: {}, proactiveCountToday: 5 }
        const score = computeFusionScore(stimulus, ctx)
        expect(score).toBe(0)
    })
})

// ─── Mode Switching Tests ───────────────────────────────────────────────────

describe('getFusionMode', () => {
    it('returns PROACTIVE mode with threshold 0.7 and max 5/day', () => {
        const mode = getFusionMode('PROACTIVE')
        expect(mode).toEqual({ mode: 'PROACTIVE', threshold: 0.7, maxProactivePerDay: 5 })
    })

    it('returns ENGAGED mode with threshold 0.8 and max 4/day', () => {
        const mode = getFusionMode('ENGAGED')
        expect(mode).toEqual({ mode: 'ENGAGED', threshold: 0.8, maxProactivePerDay: 4 })
    })

    it('returns CURIOUS mode with threshold 0.85 and max 2/day', () => {
        const mode = getFusionMode('CURIOUS')
        expect(mode).toEqual({ mode: 'CURIOUS', threshold: 0.85, maxProactivePerDay: 2 })
    })

    it('returns PASSIVE mode with threshold 0.9 and max 1/day', () => {
        const mode = getFusionMode('PASSIVE')
        expect(mode).toEqual({ mode: 'PASSIVE', threshold: 0.9, maxProactivePerDay: 1 })
    })
})

// ─── Pushback Protocol Tests ────────────────────────────────────────────────

describe('evaluatePushback', () => {
    it('returns ALLOW with 0 pulseDelta when no rejections', () => {
        const result = evaluatePushback(0)
        expect(result.action).toBe('ALLOW')
        expect(result.pulseDelta).toBe(0)
    })

    it('returns RETRY_PIVOT with Pulse -18 on 1st rejection', () => {
        const result = evaluatePushback(1)
        expect(result.action).toBe('RETRY_PIVOT')
        expect(result.pulseDelta).toBe(PUSHBACK_PULSE_DELTA)
        expect(result.pulseDelta).toBe(-18)
    })

    it('returns BACK_OFF with Pulse -18 on 2nd rejection', () => {
        const result = evaluatePushback(2)
        expect(result.action).toBe('BACK_OFF')
        expect(result.pulseDelta).toBe(-18)
    })

    it('returns BACK_OFF for 3+ rejections', () => {
        const result = evaluatePushback(5)
        expect(result.action).toBe('BACK_OFF')
    })
})

// ─── Recovery Protocol Tests ────────────────────────────────────────────────

describe('checkRecovery', () => {
    const baseCtx: UserContext = {
        userId: 'test',
        pulseState: 'ENGAGED',
        pulseScore: 60,
        preferences: {},
        recentPushbacks: 0,
        proactiveCountToday: 0,
        positiveInteractionStreak: 0,
        reactiveOnly: true,
    }

    it('returns shouldRecover=false when not in reactiveOnly mode', () => {
        const ctx: UserContext = { ...baseCtx, reactiveOnly: false }
        const result = checkRecovery(ctx)
        expect(result.shouldRecover).toBe(false)
    })

    it('returns shouldRecover=false when in CURIOUS state', () => {
        const ctx: UserContext = { ...baseCtx, pulseState: 'CURIOUS' }
        const result = checkRecovery(ctx)
        expect(result.shouldRecover).toBe(false)
        expect(result.reason).toContain('CURIOUS')
    })

    it('returns shouldRecover=false with only 2 positive interactions', () => {
        const ctx: UserContext = { ...baseCtx, positiveInteractionStreak: 2 }
        const result = checkRecovery(ctx)
        expect(result.shouldRecover).toBe(false)
        expect(result.reason).toContain('2/3')
    })

    it('returns shouldRecover=true with 3+ positive interactions in ENGAGED', () => {
        const ctx: UserContext = { ...baseCtx, positiveInteractionStreak: 3 }
        const result = checkRecovery(ctx)
        expect(result.shouldRecover).toBe(true)
        expect(result.recoveryThreshold).toBe(0.85)
    })

    it('returns shouldRecover=true in PROACTIVE state with 3+ positives', () => {
        const ctx: UserContext = { ...baseCtx, pulseState: 'PROACTIVE', positiveInteractionStreak: 4 }
        const result = checkRecovery(ctx)
        expect(result.shouldRecover).toBe(true)
    })
})

// ─── Proactive Decision Tests ───────────────────────────────────────────────

describe('fusionProactiveDecision', () => {
    const stimulus: StimulusInput = {
        type: 'weather',
        key: 'rain_commute',
        weight: 0.9,
        data: { condition: 'rain' },
    }

    const baseCtx: UserContext = {
        userId: 'test',
        pulseState: 'PROACTIVE',
        pulseScore: 85,
        preferences: { weather_pref: 'rain' },
        recentPushbacks: 0,
        proactiveCountToday: 0,
        positiveInteractionStreak: 0,
        reactiveOnly: false,
    }

    it('returns FIRE for high-scoring PROACTIVE user', () => {
        const decision = fusionProactiveDecision(stimulus, baseCtx)
        // score = 0.9 * 1.0 * 1.0 * 1.0 = 0.9 >= threshold 0.7
        expect(decision.action).toBe('FIRE')
        expect(decision.score).toBeCloseTo(0.9)
        expect(decision.pulseDelta).toBe(0)
    })

    it('returns DROP for PASSIVE user with low-weight stimulus', () => {
        const lowStimulus: StimulusInput = { type: 'price', key: 'price_drop', weight: 0.4, data: { item: 'shoes' } }
        const ctx: UserContext = { ...baseCtx, pulseState: 'PASSIVE', pulseScore: 10, preferences: {} }
        const decision = fusionProactiveDecision(lowStimulus, ctx)
        expect(decision.action).toBe('DROP')
    })

    it('returns DROP with BACK_OFF reason on 2nd rejection', () => {
        const ctx: UserContext = { ...baseCtx, recentPushbacks: 2 }
        const decision = fusionProactiveDecision(stimulus, ctx)
        expect(decision.action).toBe('DROP')
        expect(decision.reason).toContain('back-off')
        expect(decision.pulseDelta).toBe(-18)
    })

    it('on 1st rejection, FIRE only if score exceeds retry threshold', () => {
        // 1st rejection: retry threshold = mode.threshold + 0.1 = 0.7 + 0.1 = 0.8
        // score = 0.9 >= 0.8, so should FIRE with pivot note
        const ctx: UserContext = { ...baseCtx, recentPushbacks: 1 }
        const decision = fusionProactiveDecision(stimulus, ctx)
        expect(decision.action).toBe('FIRE')
        expect(decision.reason).toContain('Retry pivot')
    })

    it('on 1st rejection, BUFFER if score below retry threshold', () => {
        // Lower weight stimulus: score will be lower
        const weakStimulus: StimulusInput = { type: 'food', key: 'food_deal', weight: 0.5, data: { deal: 'bogo' } }
        const ctx: UserContext = { ...baseCtx, recentPushbacks: 1, preferences: {} }
        // score = 0.5 * 0.3 * 1.0 * 1.0 = 0.15 < retry threshold 0.8
        const decision = fusionProactiveDecision(weakStimulus, ctx)
        expect(decision.action).toBe('BUFFER')
        expect(decision.reason).toContain('Retry pivot')
    })

    it('in reactiveOnly mode, only BUFFERs (never FIREs)', () => {
        const ctx: UserContext = { ...baseCtx, reactiveOnly: true, positiveInteractionStreak: 0 }
        const decision = fusionProactiveDecision(stimulus, ctx)
        expect(decision.action).toBe('BUFFER')
        expect(decision.reason).toContain('REACTIVE-only')
    })

    it('in reactiveOnly mode with 3+ positives in ENGAGED, recovers and FIREs', () => {
        const ctx: UserContext = {
            ...baseCtx,
            reactiveOnly: true,
            positiveInteractionStreak: 3,
            pulseState: 'ENGAGED',
        }
        // score = 0.9 * 1.0 * 0.8 * 1.0 = 0.72
        // recovery threshold = 0.85, so 0.72 < 0.85 → BUFFER
        const decision = fusionProactiveDecision(stimulus, ctx)
        expect(decision.action).toBe('BUFFER')
        expect(decision.reason).toContain('recovery threshold')
    })

    it('recovery fires with very high score', () => {
        // Make score higher than 0.85: needs weight * match * receptivity > 0.85
        // 0.9 * 1.0 * 1.0 = 0.9 → need PROACTIVE state for receptivity 1.0
        const ctx: UserContext = {
            ...baseCtx,
            reactiveOnly: true,
            positiveInteractionStreak: 3,
            pulseState: 'PROACTIVE',
        }
        // score = 0.9 * 1.0 * 1.0 * 1.0 = 0.9 >= recovery threshold 0.85
        const decision = fusionProactiveDecision(stimulus, ctx)
        expect(decision.action).toBe('FIRE')
        expect(decision.reason).toContain('Recovery')
    })

    it('returns BUFFER for mid-range score in ENGAGED mode', () => {
        const midStimulus: StimulusInput = { type: 'event', key: 'concert_nearby', weight: 0.6, data: { event: 'jazz night' } }
        const ctx: UserContext = { ...baseCtx, pulseState: 'ENGAGED', pulseScore: 60, preferences: { music: 'jazz' } }
        const decision = fusionProactiveDecision(midStimulus, ctx)
        // score = 0.6 * 1.0 * 0.8 * 1.0 = 0.48
        // threshold = 0.8, buffer range = 0.6-0.8
        expect(decision.score).toBeCloseTo(0.48)
        // 0.48 < 0.6 (threshold - 0.2), so DROP
        expect(decision.action).toBe('DROP')
    })
})
