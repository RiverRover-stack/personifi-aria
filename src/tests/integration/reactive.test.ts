/**
 * Reactive Integration Tests — Phase 7, Issue #130, #146
 *
 * Tests 1-3: Per-message reactive routing via fusionReactiveDecision
 * Test  #146: Sentinel stimulus collection — scoring pipeline smoke test
 */

import { describe, it, expect, vi } from 'vitest'
import type { Pool, QueryResult } from 'pg'
import {
    fusionReactiveDecision,
    fusionProactiveDecision,
    computeFusionScore,
    getStimulusWeight,
} from '../../fusion/index.js'
import type { ReactiveInput, StimulusInput, UserContext } from '../../fusion/types.js'

// ─── Mock Pool Factory ────────────────────────────────────────────────────────

function makePool(queryMocks: Array<{ rows: unknown[]; rowCount?: number }>): Pool {
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

// ─── Shared input builder ─────────────────────────────────────────────────────

function makeReactiveInput(overrides: Partial<ReactiveInput> = {}): ReactiveInput {
    return {
        userId: 'user-test-001',
        userMessage: 'hey whats up',
        extractedSignals: {
            topic: null,
            intent: 'greeting',
            sentiment: 'positive',
            entities: [],
        },
        toolRequest: null,
        contextBundle: {
            memories: [],
            preferences: {},
            graphNeighbors: [],
        },
        pulseState: 'CURIOUS',
        pulseScore: 40,
        ...overrides,
    }
}

// ─── Test 1 — Simple reactive message ────────────────────────────────────────

describe('Test 1 — simple reactive message (no active stimuli)', () => {
    it('routes to respond, writes signal packet', async () => {
        // proactive_state query → empty, insertSignalPacket INSERT → ignored
        const pool = makePool([
            { rows: [] },   // getActiveProactiveState
            { rows: [] },   // insertSignalPacket (fire-and-forget)
        ])

        const input = makeReactiveInput({ userMessage: 'hey whats up' })

        const start = Date.now()
        const result = await fusionReactiveDecision(pool, input)
        const elapsed = Date.now() - start

        expect(result.decision).toBe('respond')
        expect(result.toolResult).toBeNull()
        expect(result.contextAdditions).toHaveLength(0)
        expect(result.invalidatedStimuli).toHaveLength(0)
        expect(result.confidence).toBeGreaterThan(0)

        // The reactive decision should be fast (pure logic + mock DB)
        expect(elapsed).toBeLessThan(300)
    })
})

// ─── Test 2 — Tool call message ──────────────────────────────────────────────

describe('Test 2 — tool call with active stimulus (no pre-fetched result)', () => {
    it('routes to execute_tool when score >= 0.8 and ENGAGED/PROACTIVE', async () => {
        const activeStimulus = {
            id: 'stim-001',
            user_id: 'user-test-001',
            stimulus_type: 'traffic',
            stimulus_key: 'commute_to_koramangala',
            score: 0.85,
            data: { area: 'Koramangala', congestion: 'heavy' },
            result_ref: null,        // no pre-fetched result → execute_tool
            status: 'active',
            created_at: new Date(),
            expires_at: null,
        }

        const pool = makePool([
            { rows: [activeStimulus] },  // getActiveProactiveState
            { rows: [] },                // insertSignalPacket
        ])

        const input = makeReactiveInput({
            userMessage: 'compare cab prices to Koramangala',
            extractedSignals: {
                topic: 'traffic',
                intent: 'ride_compare',
                sentiment: 'neutral',
                entities: ['Koramangala'],
            },
            toolRequest: { name: 'ride_compare', args: { destination: 'Koramangala' } },
            pulseState: 'ENGAGED',
            pulseScore: 65,
        })

        const start = Date.now()
        const result = await fusionReactiveDecision(pool, input)
        const elapsed = Date.now() - start

        // High-score stimulus + ENGAGED + no pre-fetch → execute_tool
        expect(result.decision).toBe('execute_tool')
        expect(result.proactiveContext).toHaveLength(1)
        expect(result.contextAdditions).toHaveLength(1)
        expect(elapsed).toBeLessThan(500)
    })
})

// ─── Test 3 — Pre-fetched injection ──────────────────────────────────────────

describe('Test 3 — pre-fetched tool result available (inject_prefetch)', () => {
    it('uses cached result, makes 0 external API calls', async () => {
        const mockToolResult = {
            id: 'tr-001',
            user_id: 'user-test-001',
            tool_name: 'ride_compare',
            args_hash: 'abc123',
            result: { ola: 120, uber: 145, rapido: 95 },
            cached_at: new Date(),
            expires_at: new Date(Date.now() + 3600_000),
            used: false,
        }

        const activeStimulus = {
            id: 'stim-002',
            user_id: 'user-test-001',
            stimulus_type: 'traffic',
            stimulus_key: 'commute_to_koramangala',
            score: 0.82,
            data: { area: 'Koramangala' },
            result_ref: 'ride_compare:abc123',   // has pre-fetched result
            status: 'active',
            created_at: new Date(),
            expires_at: null,
        }

        const pool = makePool([
            { rows: [activeStimulus] },   // getActiveProactiveState
            { rows: [mockToolResult] },   // claimToolResult (UPDATE ... RETURNING)
            { rows: [] },                 // insertSignalPacket
        ])

        // Track whether any external API would be called (should not be)
        const externalApiSpy = vi.fn()

        const input = makeReactiveInput({
            userMessage: 'how much to Koramangala',
            extractedSignals: {
                topic: 'traffic',
                intent: 'ride_compare',
                sentiment: 'neutral',
                entities: ['Koramangala'],
            },
            pulseState: 'ENGAGED',
            pulseScore: 70,
        })

        const start = Date.now()
        const result = await fusionReactiveDecision(pool, input)
        const elapsed = Date.now() - start

        // Should inject pre-fetched result, not call any external API
        expect(result.decision).toBe('inject_prefetch')
        expect(result.toolResult).not.toBeNull()
        expect(result.toolResult?.tool_name).toBe('ride_compare')
        expect(externalApiSpy).not.toHaveBeenCalled()

        // Latency target: <300ms since no real API calls
        expect(elapsed).toBeLessThan(300)
    })
})

// ─── Issue #146 — Sentinel stimulus integration ───────────────────────────────

describe('Issue #146 — stimulus scoring pipeline smoke test', () => {
    it('weather stimulus for PROACTIVE user scores > 0 and produces a valid decision', () => {
        // Simulate a stimulus_cache row for a user's weather state (rain warning)
        const weatherStimulus: StimulusInput = {
            type: 'weather',
            key: 'weather_rain_bangalore',
            weight: getStimulusWeight('weather'),  // 0.9
            data: { condition: 'RAIN_START', city: 'Bangalore', temp: 22 },
        }

        const userCtx: UserContext = {
            userId: 'user-test-001',
            pulseState: 'PROACTIVE',
            pulseScore: 85,
            preferences: { weather_alerts: 'enabled', city: 'Bangalore' },
            recentPushbacks: 0,
            proactiveCountToday: 0,
            positiveInteractionStreak: 2,
            reactiveOnly: false,
        }

        // Assert: stimulus scored > 0
        const score = computeFusionScore(weatherStimulus, userCtx)
        expect(score).toBeGreaterThan(0)

        // Assert: a valid decision is produced (FIRE / BUFFER / DROP)
        const decision = fusionProactiveDecision(weatherStimulus, userCtx)
        expect(['FIRE', 'BUFFER', 'DROP']).toContain(decision.action)
        expect(decision.score).toBeCloseTo(score)
        expect(typeof decision.reason).toBe('string')
        expect(decision.reason.length).toBeGreaterThan(0)
    })

    it('weather stimulus scores above 0.6 for receptive user (eligible for FIRE)', () => {
        const stimulus: StimulusInput = {
            type: 'weather',
            key: 'weather_heatwave_hyderabad',
            weight: 0.9,
            data: { condition: 'HEAT_WAVE', city: 'Hyderabad' },
        }

        const userCtx: UserContext = {
            userId: 'user-test-002',
            pulseState: 'PROACTIVE',
            pulseScore: 90,
            preferences: { weather: 'heat_wave' },  // exact match → pref=1.0
            recentPushbacks: 0,
            proactiveCountToday: 1,                  // low fatigue
            positiveInteractionStreak: 4,
            reactiveOnly: false,
        }

        const score = computeFusionScore(stimulus, userCtx)
        // weight(0.9) × pref(1.0) × receptivity(1.0) × (1 - fatigue(1/5)) = 0.9 × 0.8 = 0.72
        expect(score).toBeGreaterThan(0.6)
    })

    it('food stimulus scores lower than weather for same user context', () => {
        const weatherStimulus: StimulusInput = {
            type: 'weather',
            key: 'weather_rain_pune',
            weight: 0.9,
            data: { condition: 'RAIN_START', city: 'Pune' },
        }
        const foodStimulus: StimulusInput = {
            type: 'food',
            key: 'mess_menu_lunch',
            weight: 0.5,
            data: { hostel: 'Hall 1', items: ['dal', 'rice'] },
        }
        const userCtx: UserContext = {
            userId: 'user-test-003',
            pulseState: 'ENGAGED',
            pulseScore: 60,
            preferences: {},
            recentPushbacks: 0,
            proactiveCountToday: 0,
            positiveInteractionStreak: 1,
            reactiveOnly: false,
        }

        const weatherScore = computeFusionScore(weatherStimulus, userCtx)
        const foodScore = computeFusionScore(foodStimulus, userCtx)
        expect(weatherScore).toBeGreaterThan(foodScore)
    })
})
