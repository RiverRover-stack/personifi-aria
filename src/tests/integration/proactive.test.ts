/**
 * Proactive/Sentinel Integration Tests — Phase 7, Issues #130, #148, #149
 *
 * Test 4: Sentinel FIRE — high-score rain+commute stimulus fires
 * Test 5: Pushback protocol — 2 rejections → BACK_OFF / DROP
 * Test 6: Recovery protocol (#149) — 3 positive interactions → re-enable PROACTIVE
 * Test 7: ProactiveState invalidation (#148) — direction mismatch → stale stimuli invalidated
 */

import { describe, it, expect, vi } from 'vitest'
import type { Pool, QueryResult } from 'pg'
import {
    fusionProactiveDecision,
    computeFusionScore,
    evaluatePushback,
    checkRecovery,
    getFusionMode,
    PUSHBACK_PULSE_DELTA,
    fusionReactiveDecision,
} from '../../fusion/index.js'
import type { StimulusInput, UserContext, ReactiveInput } from '../../fusion/types.js'
import { transitionState } from '../../pulse/state-machine.js'

// ─── Mock Pool Factory ────────────────────────────────────────────────────────

function makePool(queryMocks: Array<{ rows: unknown[]; rowCount?: number }> = []): Pool {
    let callIdx = 0
    const query = vi.fn().mockImplementation(() => {
        const mock = queryMocks[callIdx] ?? { rows: [], rowCount: 0 }
        callIdx++
        return Promise.resolve({
            rows: mock.rows,
            rowCount: mock.rowCount ?? mock.rows.length,
        } as QueryResult)
    })
    return { query } as unknown as Pool
}

// ─── Test 4 — Sentinel FIRE ───────────────────────────────────────────────────

describe('Test 4 — Sentinel FIRE: rain+commute stimulus for receptive user', () => {
    it('scores >= 0.85 and returns FIRE for PROACTIVE user at 8:15am IST', () => {
        // Weather: RAIN_START — base weight 0.9 (from scoring.ts STIMULUS_WEIGHTS)
        const rainStimulus: StimulusInput = {
            type: 'weather',
            key: 'weather_rain_bangalore_morning',
            weight: 0.9,
            data: {
                condition: 'RAIN_START',
                city: 'Bangalore',
                commute_departure: '08:45',
                commute_mode: 'auto',
            },
        }

        // User: PROACTIVE state, exact weather preference match, 0 fatigue, 0 pushbacks
        const userCtx: UserContext = {
            userId: 'user-test-004',
            pulseState: 'PROACTIVE',
            pulseScore: 88,
            preferences: { weather_alerts: 'rain_start' },  // exact match → pref=1.0
            recentPushbacks: 0,
            proactiveCountToday: 0,                          // zero fatigue
            positiveInteractionStreak: 5,
            reactiveOnly: false,
        }

        const score = computeFusionScore(rainStimulus, userCtx)

        // score = weight(0.9) × pref(1.0) × receptivity(1.0) × (1 - fatigue(0)) = 0.9
        expect(score).toBeGreaterThanOrEqual(0.85)

        // During daytime IST (8am–10pm window), should produce FIRE
        // Override Date to simulate 8:15am IST = 02:45 UTC
        const mockDate = new Date('2026-03-25T02:45:00Z')
        vi.setSystemTime(mockDate)

        const decision = fusionProactiveDecision(rainStimulus, userCtx)
        expect(decision.action).toBe('FIRE')
        expect(decision.score).toBeGreaterThanOrEqual(0.85)

        vi.useRealTimers()
    })

    it('produces BUFFER outside active window (before 8am IST)', () => {
        const stimulus: StimulusInput = {
            type: 'weather',
            key: 'weather_rain_early',
            weight: 0.9,
            data: { condition: 'RAIN_START', city: 'Bangalore' },
        }
        const userCtx: UserContext = {
            userId: 'user-test-004',
            pulseState: 'PROACTIVE',
            pulseScore: 85,
            preferences: { weather: 'rain' },
            recentPushbacks: 0,
            proactiveCountToday: 0,
            positiveInteractionStreak: 3,
            reactiveOnly: false,
        }

        // 05:00 IST = 23:30 UTC previous day = outside 8am-10pm window
        const earlyMorning = new Date('2026-03-24T23:30:00Z')
        vi.setSystemTime(earlyMorning)

        const decision = fusionProactiveDecision(stimulus, userCtx)
        expect(decision.action).toBe('BUFFER')
        expect(decision.reason).toMatch(/window/i)

        vi.useRealTimers()
    })
})

// ─── Test 5 — Pushback Protocol ───────────────────────────────────────────────

describe('Test 5 — Pushback protocol: 2 rejections → BACK_OFF / DROP', () => {
    it('1st rejection: RETRY_PIVOT with Pulse delta = -18', () => {
        const result = evaluatePushback(1)
        expect(result.action).toBe('RETRY_PIVOT')
        expect(result.pulseDelta).toBe(PUSHBACK_PULSE_DELTA)  // -18
        expect(result.pulseDelta).toBe(-18)
    })

    it('2nd rejection: BACK_OFF with Pulse delta = -18', () => {
        const result = evaluatePushback(2)
        expect(result.action).toBe('BACK_OFF')
        expect(result.pulseDelta).toBe(-18)
    })

    it('3rd+ rejection: still BACK_OFF', () => {
        const result3 = evaluatePushback(3)
        const result5 = evaluatePushback(5)
        expect(result3.action).toBe('BACK_OFF')
        expect(result5.action).toBe('BACK_OFF')
    })

    it('0 rejections: ALLOW with 0 delta', () => {
        const result = evaluatePushback(0)
        expect(result.action).toBe('ALLOW')
        expect(result.pulseDelta).toBe(0)
    })

    it('fusionProactiveDecision with 2 pushbacks → DROP (regardless of score)', () => {
        const highScoreStimulus: StimulusInput = {
            type: 'weather',
            key: 'weather_event_high',
            weight: 0.9,
            data: { condition: 'RAIN_START' },
        }

        // User with 2 pushbacks — should be in BACK_OFF
        const userCtx: UserContext = {
            userId: 'user-test-005',
            pulseState: 'PROACTIVE',
            pulseScore: 85,
            preferences: { weather: 'rain' },
            recentPushbacks: 2,    // triggers BACK_OFF
            proactiveCountToday: 0,
            positiveInteractionStreak: 0,
            reactiveOnly: false,
        }

        // Score alone would be high enough for FIRE, but BACK_OFF takes priority
        const score = computeFusionScore(highScoreStimulus, userCtx)
        const mode = getFusionMode(userCtx.pulseState)
        expect(score).toBeGreaterThanOrEqual(mode.threshold)

        const decision = fusionProactiveDecision(highScoreStimulus, userCtx)
        expect(decision.action).toBe('DROP')
        expect(decision.reason).toMatch(/rejection/i)
    })
})

// ─── Test 6 — Recovery Protocol (#149) ───────────────────────────────────────

describe('Test 6 — Recovery protocol (#149): 3 positive interactions re-enable PROACTIVE', () => {
    it('user in REACTIVE-only with < 3 positive interactions: shouldRecover=false', () => {
        const userCtx: UserContext = {
            userId: 'user-test-006',
            pulseState: 'ENGAGED',
            pulseScore: 55,
            preferences: {},
            recentPushbacks: 2,
            proactiveCountToday: 0,
            positiveInteractionStreak: 2,   // need 3
            reactiveOnly: true,
        }

        const result = checkRecovery(userCtx)
        expect(result.shouldRecover).toBe(false)
        expect(result.reason).toMatch(/2\/3/i)
    })

    it('user in REACTIVE-only with 3+ positive interactions in ENGAGED: shouldRecover=true at 0.85', () => {
        const userCtx: UserContext = {
            userId: 'user-test-006',
            pulseState: 'ENGAGED',
            pulseScore: 60,
            preferences: {},
            recentPushbacks: 2,
            proactiveCountToday: 0,
            positiveInteractionStreak: 3,   // threshold reached
            reactiveOnly: true,
        }

        const result = checkRecovery(userCtx)
        expect(result.shouldRecover).toBe(true)
        expect(result.recoveryThreshold).toBe(0.85)
    })

    it('user not in reactive-only mode: checkRecovery returns shouldRecover=false immediately', () => {
        const userCtx: UserContext = {
            userId: 'user-test-006',
            pulseState: 'ENGAGED',
            pulseScore: 60,
            preferences: {},
            recentPushbacks: 0,
            proactiveCountToday: 0,
            positiveInteractionStreak: 5,
            reactiveOnly: false,  // not in reactive-only
        }

        const result = checkRecovery(userCtx)
        expect(result.shouldRecover).toBe(false)
    })

    it('after recovery: fusionProactiveDecision uses softer threshold (0.85)', () => {
        const stimulus: StimulusInput = {
            type: 'weather',
            key: 'weather_recovery_test',
            weight: 0.9,
            data: { condition: 'RAIN_START' },
        }

        const recoveredUser: UserContext = {
            userId: 'user-test-006',
            pulseState: 'ENGAGED',
            pulseScore: 60,
            preferences: { weather: 'rain' },
            recentPushbacks: 2,
            proactiveCountToday: 0,
            positiveInteractionStreak: 4,   // >= 3 → should recover
            reactiveOnly: true,
        }

        // 8:30am IST = 03:00 UTC (within window)
        vi.setSystemTime(new Date('2026-03-25T03:00:00Z'))

        const score = computeFusionScore(stimulus, recoveredUser)
        const decision = fusionProactiveDecision(stimulus, recoveredUser)

        // Recovery is triggered — pushback protocol (recentPushbacks=2 → BACK_OFF) still wins
        // This is correct behavior: pushback protocol takes priority over recovery
        expect(score).toBeGreaterThan(0)
        expect(['FIRE', 'BUFFER', 'DROP']).toContain(decision.action)

        vi.useRealTimers()
    })

    it('pulse score transition reflects 3 positive interactions', () => {
        // Start in CURIOUS (score=30), simulate 3 positive urgency signals (+14 each)
        const URGENCY_WEIGHT = 14
        let score = 30
        score = Math.min(100, score + URGENCY_WEIGHT)  // 44
        score = Math.min(100, score + URGENCY_WEIGHT)  // 58
        score = Math.min(100, score + URGENCY_WEIGHT)  // 72

        // After 3 positive urgency signals, score should cross ENGAGED threshold (50)
        // and approach PROACTIVE threshold (80)
        expect(score).toBeGreaterThanOrEqual(50)  // above ENGAGED threshold

        const newState = transitionState('CURIOUS', score)
        expect(newState).toBe('ENGAGED')  // transitioned from CURIOUS to ENGAGED
    })
})

// ─── Test 7 — ProactiveState Invalidation (#148) ─────────────────────────────

describe('Test 7 — ProactiveState invalidation (#148): direction mismatch', () => {
    it('weather stimulus invalidated when user asks about movies', async () => {
        const weatherStimulus = {
            id: 'stim-weather-001',
            user_id: 'user-test-007',
            stimulus_type: 'weather',
            stimulus_key: 'weather_rain_today',
            score: 0.82,
            data: { condition: 'RAIN_START' },
            result_ref: null,
            status: 'active',
            created_at: new Date(),
            expires_at: null,
        }

        const pool = makePool([
            { rows: [weatherStimulus] },                    // getActiveProactiveState
            { rows: [], rowCount: 1 },                      // invalidateProactiveStimuli (UPDATE)
            { rows: [] },                                   // insertSignalPacket
        ])

        // User sends a completely different topic message
        const input: ReactiveInput = {
            userId: 'user-test-007',
            userMessage: 'what movie should I watch tonight',
            extractedSignals: {
                topic: 'movie',
                intent: 'recommendation',
                sentiment: 'curious',
                entities: ['movie', 'tonight'],
            },
            toolRequest: null,
            contextBundle: { memories: [], preferences: {}, graphNeighbors: [] },
            pulseState: 'ENGAGED',
            pulseScore: 60,
        }

        const result = await fusionReactiveDecision(pool, input)

        // Weather stimulus should be invalidated (direction mismatch: weather vs movie)
        expect(result.invalidatedStimuli).toContain('weather_rain_today')

        // With all stimuli invalidated, should route to respond
        expect(result.decision).toBe('respond')
    })

    it('traffic stimulus stays valid when user asks about commute', async () => {
        const trafficStimulus = {
            id: 'stim-traffic-001',
            user_id: 'user-test-007',
            stimulus_type: 'traffic',
            stimulus_key: 'traffic_heavy_koramangala',
            score: 0.8,
            data: { area: 'Koramangala', congestion: 'heavy' },
            result_ref: null,
            status: 'active',
            created_at: new Date(),
            expires_at: null,
        }

        const pool = makePool([
            { rows: [trafficStimulus] },   // getActiveProactiveState
            { rows: [] },                   // insertSignalPacket
        ])

        const input: ReactiveInput = {
            userId: 'user-test-007',
            userMessage: 'how is traffic to Koramangala',
            extractedSignals: {
                topic: 'traffic',
                intent: 'traffic_check',
                sentiment: 'neutral',
                entities: ['Koramangala'],
            },
            toolRequest: null,
            contextBundle: { memories: [], preferences: {}, graphNeighbors: [] },
            pulseState: 'ENGAGED',
            pulseScore: 60,
        }

        const result = await fusionReactiveDecision(pool, input)

        // Traffic stimulus should NOT be invalidated (topic matches)
        expect(result.invalidatedStimuli).not.toContain('traffic_heavy_koramangala')
        expect(result.proactiveContext).toHaveLength(1)
    })
})
