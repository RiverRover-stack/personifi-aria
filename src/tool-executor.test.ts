/**
 * Unit tests for Alpha Tool Executor (#129)
 *
 * Verifies correct name mapping (Alpha → legacy), stub returns for Phase 3
 * tools, event_lookup query injection, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeAlphaTool } from './tool-executor.js'
import type { ToolExecutionResult } from './hooks.js'

// ─── Mock bodyHooks ───────────────────────────────────────────────────────────

const mockExecuteTool = vi.fn<[string, Record<string, unknown>], Promise<ToolExecutionResult>>()

vi.mock('./tools/index.js', () => ({
    bodyHooks: {
        executeTool: (...args: [string, Record<string, unknown>]) => mockExecuteTool(...args),
        getAvailableTools: () => [],
    },
}))

// Mock logger to silence output during tests
vi.mock('./logger.js', () => ({
    logger: {
        child: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

const successResult = (data: unknown): ToolExecutionResult => ({ success: true, data })
const failResult = (error: string): ToolExecutionResult => ({ success: false, data: null, error })

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('executeAlphaTool — name mapping', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockExecuteTool.mockResolvedValue(successResult({ rides: [] }))
    })

    it('cab_compare → compare_rides', async () => {
        await executeAlphaTool('cab_compare', { pickup: 'Koramangala', destination: 'Airport' })
        expect(mockExecuteTool).toHaveBeenCalledWith('compare_rides', { pickup: 'Koramangala', destination: 'Airport' })
    })

    it('place_search → search_places', async () => {
        await executeAlphaTool('place_search', { query: 'coffee', location: 'Indiranagar' })
        expect(mockExecuteTool).toHaveBeenCalledWith('search_places', { query: 'coffee', location: 'Indiranagar' })
    })

    it('weather_check → get_weather', async () => {
        await executeAlphaTool('weather_check', { location: 'Bangalore' })
        expect(mockExecuteTool).toHaveBeenCalledWith('get_weather', { location: 'Bangalore' })
    })

    it('food_finder → compare_food_prices', async () => {
        await executeAlphaTool('food_finder', { query: 'biryani' })
        expect(mockExecuteTool).toHaveBeenCalledWith('compare_food_prices', { query: 'biryani' })
    })

    it('price_alert → compare_prices_proactive', async () => {
        await executeAlphaTool('price_alert', { query: 'milk 1L' })
        expect(mockExecuteTool).toHaveBeenCalledWith('compare_prices_proactive', { query: 'milk 1L' })
    })
})

describe('executeAlphaTool — event_lookup query injection', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockExecuteTool.mockResolvedValue(successResult({ places: [] }))
    })

    it('routes event_lookup to search_places', async () => {
        await executeAlphaTool('event_lookup', { query: 'concerts', location: 'Bangalore' })
        expect(mockExecuteTool).toHaveBeenCalledWith(
            'search_places',
            expect.objectContaining({ location: 'Bangalore' })
        )
    })

    it('prefixes query with "events:" to bias place search toward events', async () => {
        await executeAlphaTool('event_lookup', { query: 'standup comedy', location: 'HSR Layout' })
        const calledArgs = mockExecuteTool.mock.calls[0][1]
        expect((calledArgs.query as string).startsWith('events:')).toBe(true)
        expect(calledArgs.query).toContain('standup comedy')
    })

    it('sets openNow to false (events are date-specific, not open-now)', async () => {
        await executeAlphaTool('event_lookup', { query: 'art show', location: 'MG Road' })
        expect(mockExecuteTool.mock.calls[0][1].openNow).toBe(false)
    })
})

describe('executeAlphaTool — Phase 3 stubs', () => {
    beforeEach(() => vi.clearAllMocks())

    it('friend_activity returns stub success without calling bodyHooks', async () => {
        const result = await executeAlphaTool('friend_activity', { friendId: 'user_123' })
        expect(result.success).toBe(true)
        expect(mockExecuteTool).not.toHaveBeenCalled()
    })

    it('set_reminder returns stub success without calling bodyHooks', async () => {
        const result = await executeAlphaTool('set_reminder', { message: 'Buy milk', time: 'in 1 hour' })
        expect(result.success).toBe(true)
        expect(mockExecuteTool).not.toHaveBeenCalled()
    })

    it('friend_activity stub data mentions Phase 3 unavailability', async () => {
        const result = await executeAlphaTool('friend_activity', { friendId: 'user_456' })
        const data = result.data as { status: string; message: string }
        expect(data.status).toBe('unavailable')
    })

    it('set_reminder stub data acknowledges the reminder', async () => {
        const result = await executeAlphaTool('set_reminder', { message: 'Walk the dog', time: 'tomorrow morning' })
        const data = result.data as { status: string }
        expect(data.status).toBe('acknowledged')
    })
})

describe('executeAlphaTool — unknown tool name', () => {
    it('returns failure for phantom tool without calling bodyHooks', async () => {
        const result = await executeAlphaTool('hack_the_planet', { target: 'all' })
        expect(result.success).toBe(false)
        expect(result.error).toContain('Unknown Alpha tool')
        expect(mockExecuteTool).not.toHaveBeenCalled()
    })
})

describe('executeAlphaTool — error handling', () => {
    it('catches unexpected throws from bodyHooks and returns failure', async () => {
        mockExecuteTool.mockRejectedValueOnce(new Error('API timeout'))
        const result = await executeAlphaTool('weather_check', { location: 'Delhi' })
        expect(result.success).toBe(false)
        expect(result.error).toContain('weather_check')
    })

    it('returns bodyHooks failure result as-is', async () => {
        mockExecuteTool.mockResolvedValueOnce(failResult('Rate limit exceeded'))
        const result = await executeAlphaTool('place_search', { query: 'gym' })
        expect(result.success).toBe(false)
        expect(result.error).toBe('Rate limit exceeded')
    })
})
