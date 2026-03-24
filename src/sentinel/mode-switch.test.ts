import { describe, it, expect } from 'vitest'
import { evaluateModeSwitch, recordPositiveInteraction, recordPushback } from './mode-switch.js'
import type { SentinelUserContext } from './types.js'
import { MODE_THRESHOLD, REACTIVE_TO_PROACTIVE_POSITIVE_REQUIRED, RECOVERY_THRESHOLD_MULTIPLIER } from './constants.js'

function makeCtx(overrides: Partial<SentinelUserContext> = {}): SentinelUserContext {
    return {
        userId: 'u1', chatId: 'c1',
        pulseState: 'ENGAGED', pulseScore: 60,
        mode: 'PROACTIVE',
        dailyFireCount: 0, lastFireAt: 0, lastResetDate: '2026-03-24',
        pushbackCount: 0, consecutivePositive: 0, preferences: {},
        ...overrides,
    }
}

describe('evaluateModeSwitch', () => {
    it('stays PROACTIVE when score is above threshold', () => {
        const ctx = makeCtx({ mode: 'PROACTIVE', pulseScore: 60 })
        const result = evaluateModeSwitch(ctx)
        expect(result.newMode).toBe('PROACTIVE')
        expect(result.changed).toBe(false)
    })

    it('switches PROACTIVE → REACTIVE when pulse drops below threshold', () => {
        const ctx = makeCtx({ mode: 'PROACTIVE', pulseScore: MODE_THRESHOLD - 1 })
        const result = evaluateModeSwitch(ctx)
        expect(result.newMode).toBe('REACTIVE')
        expect(result.changed).toBe(true)
    })

    it('stays REACTIVE without enough positive interactions', () => {
        const ctx = makeCtx({ mode: 'REACTIVE', pulseScore: 48, consecutivePositive: 2 })
        const result = evaluateModeSwitch(ctx)
        expect(result.newMode).toBe('REACTIVE')
        expect(result.changed).toBe(false)
    })

    it('switches REACTIVE → PROACTIVE after 3 positives + score >= soft threshold', () => {
        const softThreshold = MODE_THRESHOLD * RECOVERY_THRESHOLD_MULTIPLIER // 42.5
        const ctx = makeCtx({
            mode: 'REACTIVE',
            pulseScore: softThreshold + 1,
            consecutivePositive: REACTIVE_TO_PROACTIVE_POSITIVE_REQUIRED,
        })
        const result = evaluateModeSwitch(ctx)
        expect(result.newMode).toBe('PROACTIVE')
        expect(result.changed).toBe(true)
    })

    it('does NOT switch REACTIVE → PROACTIVE if score is below soft threshold', () => {
        const softThreshold = MODE_THRESHOLD * RECOVERY_THRESHOLD_MULTIPLIER
        const ctx = makeCtx({ mode: 'REACTIVE', pulseScore: softThreshold - 1, consecutivePositive: 3 })
        const result = evaluateModeSwitch(ctx)
        expect(result.newMode).toBe('REACTIVE')
        expect(result.changed).toBe(false)
    })

    it('emits alert on ENGAGED → CURIOUS drop', () => {
        const ctx = makeCtx({ mode: 'PROACTIVE', pulseState: 'CURIOUS', pulseScore: 30 })
        const result = evaluateModeSwitch(ctx, 'ENGAGED')
        expect(result.alert).toBeTruthy()
        expect(result.alert).toContain('ENGAGED → CURIOUS')
    })

    it('does NOT emit alert if previous state was not ENGAGED', () => {
        const ctx = makeCtx({ mode: 'PROACTIVE', pulseState: 'CURIOUS', pulseScore: 30 })
        const result = evaluateModeSwitch(ctx, 'CURIOUS')
        expect(result.alert).toBeUndefined()
    })
})

describe('recordPushback', () => {
    it('increments pushbackCount and resets consecutivePositive', () => {
        const ctx = makeCtx({ pushbackCount: 1, consecutivePositive: 3 })
        recordPushback(ctx)
        expect(ctx.pushbackCount).toBe(2)
        expect(ctx.consecutivePositive).toBe(0)
    })
})

describe('recordPositiveInteraction', () => {
    it('increments consecutivePositive', () => {
        const ctx = makeCtx({ consecutivePositive: 1 })
        recordPositiveInteraction(ctx)
        expect(ctx.consecutivePositive).toBe(2)
    })
})
