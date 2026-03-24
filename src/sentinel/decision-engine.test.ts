import { describe, it, expect, vi } from 'vitest'
import { decideSentinelActions, isWithinActiveHours } from './decision-engine.js'
import type { SentinelUserContext, ScoredStimulus } from './types.js'
import type { StimulusInput } from '../fusion/types.js'
import { DAILY_FIRE_LIMIT_DEFAULT, DAILY_FIRE_LIMIT_PROACTIVE } from './constants.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Creates a stimulus that will score high in fusionProactiveDecision.
 * Uses type=weather, key containing 'rain', and ctx should have preferences={weather:'rain'}.
 * With PROACTIVE pulseState: score = 0.9 * 1.0 * 1.0 * (1 - fatigue)
 */
function makeStimulus(score: number, key = 'rain_commute', type = 'weather'): ScoredStimulus {
    const stimulus: StimulusInput = {
        type,
        key,
        weight: 0.9,
        data: { message: 'Test message', suggestedAction: 'Test action' },
    }
    return { userId: 'u1', category: 'stimulus_refresh', stimulus, compositeScore: score, socialBoost: 1.0 }
}

/** Context that will produce high fusion scores: PROACTIVE pulse + weather preference match */
function makeHighScoreCtx(overrides: Partial<SentinelUserContext> = {}): SentinelUserContext {
    return makeCtx({
        pulseState: 'PROACTIVE',
        pulseScore: 85,
        preferences: { weather: 'rain' }, // matches stimulus key 'rain_commute'
        ...overrides,
    })
}

// Set time to 10am IST = 4:30am UTC
function setActiveTime() { vi.setSystemTime(new Date('2026-03-24T04:30:00Z')) }
// Set time to 11pm IST = 5:30pm UTC
function setInactiveTime() { vi.setSystemTime(new Date('2026-03-24T17:30:00Z')) }

// ── Tests ────────────────────────────────────────────────────────────────────

describe('isWithinActiveHours', () => {
    it('returns true at 10am IST (4:30am UTC)', () => {
        vi.useFakeTimers()
        setActiveTime()
        expect(isWithinActiveHours()).toBe(true)
        vi.useRealTimers()
    })

    it('returns false at 11pm IST (5:30pm UTC)', () => {
        vi.useFakeTimers()
        setInactiveTime()
        expect(isWithinActiveHours()).toBe(false)
        vi.useRealTimers()
    })
})

describe('decideSentinelActions — outside active hours', () => {
    it('BUFFERs high-score stimulus when outside window', () => {
        vi.useFakeTimers()
        setInactiveTime()
        const decisions = decideSentinelActions([makeStimulus(0.85)], makeCtx())
        expect(decisions[0].action).toBe('BUFFER')
        expect(decisions[0].reason).toContain('Outside active hours')
        vi.useRealTimers()
    })

    it('DROPs low-score stimulus when outside window', () => {
        vi.useFakeTimers()
        setInactiveTime()
        const decisions = decideSentinelActions([makeStimulus(0.4)], makeCtx())
        expect(decisions[0].action).toBe('DROP')
        vi.useRealTimers()
    })
})

describe('decideSentinelActions — fatigue / daily limits', () => {
    it('DROPs when default daily fire limit is reached (3)', () => {
        vi.useFakeTimers()
        setActiveTime()
        const ctx = makeCtx({ dailyFireCount: DAILY_FIRE_LIMIT_DEFAULT })
        const decisions = decideSentinelActions([makeStimulus(0.82)], ctx)
        expect(decisions[0].action).toBe('DROP')
        expect(decisions[0].reason).toContain('Daily fire limit')
        vi.useRealTimers()
    })

    it('DROPs when PROACTIVE pulse daily limit is reached (5)', () => {
        vi.useFakeTimers()
        setActiveTime()
        const ctx = makeCtx({ dailyFireCount: DAILY_FIRE_LIMIT_PROACTIVE, pulseState: 'PROACTIVE' })
        const decisions = decideSentinelActions([makeStimulus(0.82)], ctx)
        expect(decisions[0].action).toBe('DROP')
        vi.useRealTimers()
    })

    it('does NOT drop at 4 fires due to limit when pulseState is PROACTIVE (limit is 5)', () => {
        vi.useFakeTimers()
        setActiveTime()
        // 4 fires, PROACTIVE limit is 5 → limit gate should NOT drop it
        const ctx = makeCtx({ dailyFireCount: 4, pulseState: 'PROACTIVE', lastFireAt: 0 })
        const decisions = decideSentinelActions([makeStimulus(0.9)], ctx)
        // Action may be DROP/BUFFER due to low fusion score (high fatigue), but NOT because of daily limit
        if (decisions[0].action === 'DROP') {
            expect(decisions[0].reason).not.toContain('Daily fire limit')
        }
        vi.useRealTimers()
    })
})

describe('decideSentinelActions — REACTIVE mode', () => {
    it('BUFFERs (never FIREs) in REACTIVE mode', () => {
        vi.useFakeTimers()
        setActiveTime()
        const ctx = makeCtx({ mode: 'REACTIVE' })
        const decisions = decideSentinelActions([makeStimulus(0.95)], ctx)
        expect(decisions[0].action).toBe('BUFFER')
        expect(decisions[0].reason).toContain('REACTIVE')
        vi.useRealTimers()
    })
})

describe('decideSentinelActions — cooldown', () => {
    it('BUFFERs when 25-min cooldown has not elapsed', () => {
        vi.useFakeTimers()
        setActiveTime()
        // Last fire was 5 minutes ago
        const ctx = makeCtx({ lastFireAt: Date.now() - 5 * 60_000 })
        const decisions = decideSentinelActions([makeStimulus(0.9)], ctx)
        expect(decisions[0].action).toBe('BUFFER')
        expect(decisions[0].reason).toContain('Cooldown')
        vi.useRealTimers()
    })
})

describe('decideSentinelActions — one FIRE per tick', () => {
    it('fires only once even with multiple high-score stimuli', () => {
        vi.useFakeTimers()
        setActiveTime()
        // Use PROACTIVE pulseState + preference match so fusion score is high enough to FIRE
        const ctx = makeHighScoreCtx({ lastFireAt: 0, dailyFireCount: 0 })
        const stimuli = [
            makeStimulus(0.9, 'rain_commute', 'weather'),
            makeStimulus(0.85, 'rain_morning', 'weather'),
            makeStimulus(0.80, 'rain_evening', 'weather'),
        ]
        const decisions = decideSentinelActions(stimuli, ctx)
        const fires = decisions.filter(d => d.action === 'FIRE')
        expect(fires).toHaveLength(1)
        vi.useRealTimers()
    })
})
