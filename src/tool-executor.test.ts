/**
 * Unit tests for Alpha Tool Executor (#129)
 *
 * Verifies correct name mapping (Alpha → legacy), stub returns for Phase 3
 * tools, event_lookup query injection, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeAlphaTool } from './tool-executor.js'
import { checkRateLimit } from './character/session-store.js'
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

// Mock session-store so sandbox rate-limit check and audit log don't hit the DB
vi.mock('./character/session-store.js', () => ({
    checkRateLimit: vi.fn().mockResolvedValue(true),
    getPool: vi.fn().mockReturnValue({ query: vi.fn().mockResolvedValue({}) }),
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

    it('cab_compare → compare_rides with pickup translated to origin', async () => {
        await executeAlphaTool('cab_compare', { pickup: 'Koramangala', destination: 'Airport' }, 'user-1')
        expect(mockExecuteTool).toHaveBeenCalledWith('compare_rides', { origin: 'Koramangala', destination: 'Airport' })
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
        await executeAlphaTool('food_finder', { query: 'biryani', location: 'Koramangala' }, 'user-1')
        expect(mockExecuteTool).toHaveBeenCalledWith('compare_food_prices', { query: 'biryani', location: 'Koramangala' })
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
    beforeEach(() => {
        // vi.clearAllMocks() does not reset mock implementations — only calls/results.
        // vi.resetAllMocks() is required here to clear the default mockResolvedValue
        // set by event_lookup's beforeEach, which would otherwise make retry attempts succeed.
        vi.resetAllMocks()
        vi.mocked(checkRateLimit).mockResolvedValue(true)
    })

    it('catches unexpected throws from bodyHooks and returns failure', async () => {
        mockExecuteTool.mockRejectedValueOnce(new Error('API timeout'))
        // maxRetries: 0 — single attempt, avoids 500 ms sleep and a spurious retry
        const result = await executeAlphaTool('weather_check', { location: 'Delhi' }, 'user-1', { maxRetries: 0 })
        expect(result.success).toBe(false)
        expect(result.error).toContain('weather_check')
    })

    it('returns bodyHooks failure result as-is', async () => {
        mockExecuteTool.mockResolvedValueOnce(failResult('Rate limit exceeded'))
        const result = await executeAlphaTool('place_search', { query: 'gym' }, 'user-1')
        expect(result.success).toBe(false)
        expect(result.error).toBe('Rate limit exceeded')
    })
})

// ─── Negative-path integration: 50 known-bad calls ───────────────────────────
//
// Every case in this suite must satisfy two invariants:
//   1. result.success === false
//   2. mockExecuteTool is never called  (blocked before reaching the tool)
//
// Groups (total = 50):
//   A. Unknown/phantom tool names            5
//   B. Malformed JSON rawArgs                8
//   C. Non-object, non-string rawArgs        6
//   D. cab_compare bad args                  6
//   E. weather_check bad args                3
//   F. food_finder bad args                  4
//   G. place_search bad args                 4
//   H. price_alert bad args                  3
//   I. event_lookup bad args                 4
//   J. friend_activity bad args              2
//   K. set_reminder bad args                 2
//   L. JSON strings that fail schema         2
//   M. Sandbox rate-limit block              1

describe('negative-path integration — 50 known-bad calls blocked from execution', () => {
    // Helper: assert both invariants in one call
    function expectBlocked(result: ToolExecutionResult) {
        expect(result.success).toBe(false)
        expect(mockExecuteTool).not.toHaveBeenCalled()
    }

    beforeEach(() => {
        vi.clearAllMocks()
        // Rate limit passes by default for all tests except group M
        vi.mocked(checkRateLimit).mockResolvedValue(true)
    })

    // ── A: Unknown / phantom tool names (5) ──────────────────────────────────

    it.each([
        ['', { query: 'x' }],
        ['hack_the_planet', { target: 'all' }],
        ['compare_rides', { origin: 'A', destination: 'B' }],   // legacy name, not Alpha
        ['__proto__', {}],
        ["'; DROP TABLE users; --", {}],
    ] as [string, Record<string, unknown>][])(
        'A: unknown tool name "%s" is blocked',
        async (name, args) => {
            expectBlocked(await executeAlphaTool(name, args, 'user-1'))
        },
    )

    // ── B: Malformed JSON rawArgs — string that cannot be parsed (8) ─────────

    it.each([
        ['cab_compare', '{bad json'],
        ['cab_compare', '{pickup: "A", destination: "B"}'],    // unquoted keys
        ['cab_compare', '{"pickup": "A",}'],                   // trailing comma
        ['cab_compare', '"just a string"'],                    // JSON string scalar
        ['cab_compare', '[{"pickup":"A"}]'],                   // JSON array, not object
        ['weather_check', 'null'],
        ['weather_check', '42'],
        ['weather_check', 'true'],
    ] as [string, string][])(
        'B: malformed JSON rawArgs for %s → "%s" is blocked',
        async (name, raw) => {
            expectBlocked(await executeAlphaTool(name, raw, 'user-1'))
        },
    )

    // ── C: Non-string, non-object rawArgs (6) ────────────────────────────────

    it('C1: null rawArgs is blocked', async () => {
        expectBlocked(await executeAlphaTool('weather_check', null, 'user-1'))
    })
    it('C2: undefined rawArgs is blocked', async () => {
        expectBlocked(await executeAlphaTool('weather_check', undefined, 'user-1'))
    })
    it('C3: number rawArgs is blocked', async () => {
        expectBlocked(await executeAlphaTool('weather_check', 42, 'user-1'))
    })
    it('C4: boolean rawArgs is blocked', async () => {
        expectBlocked(await executeAlphaTool('weather_check', true, 'user-1'))
    })
    it('C5: array rawArgs is blocked', async () => {
        expectBlocked(await executeAlphaTool('weather_check', [], 'user-1'))
    })
    it('C6: array-of-objects rawArgs is blocked', async () => {
        expectBlocked(await executeAlphaTool('cab_compare', [{ pickup: 'A', destination: 'B' }], 'user-1'))
    })

    // ── D: cab_compare bad args (6) ──────────────────────────────────────────

    it.each([
        [{ destination: 'Airport' }],                                      // missing pickup
        [{ pickup: 'Koramangala' }],                                       // missing destination
        [{}],                                                              // both missing
        [{ pickup: 123, destination: 'Airport' }],                         // pickup wrong type
        [{ pickup: '', destination: 'Airport' }],                          // pickup empty string
        [{ pickup: 'A', destination: 'B', passengers: 0 }],               // passengers below min(1)
    ] as [Record<string, unknown>][])(
        'D: cab_compare bad args %j is blocked',
        async (args) => {
            expectBlocked(await executeAlphaTool('cab_compare', args, 'user-1'))
        },
    )

    // ── E: weather_check bad args (3) ────────────────────────────────────────

    it.each([
        [{}],                          // missing location
        [{ location: '' }],            // empty string
        [{ location: null }],          // null instead of string
    ] as [Record<string, unknown>][])(
        'E: weather_check bad args %j is blocked',
        async (args) => {
            expectBlocked(await executeAlphaTool('weather_check', args, 'user-1'))
        },
    )

    // ── F: food_finder bad args (4) ──────────────────────────────────────────

    it.each([
        [{ location: 'Bangalore' }],                   // missing query (required)
        [{ query: 'biryani' }],                        // missing location (now required)
        [{}],                                          // both missing
        [{ query: '', location: 'Bangalore' }],        // empty query
    ] as [Record<string, unknown>][])(
        'F: food_finder bad args %j is blocked',
        async (args) => {
            expectBlocked(await executeAlphaTool('food_finder', args, 'user-1'))
        },
    )

    // ── G: place_search bad args (4) ─────────────────────────────────────────

    it.each([
        [{}],                                              // missing query
        [{ query: 'cafe', openNow: 'yes' }],              // openNow is string, not boolean
        [{ query: 'cafe', minRating: 0 }],                // minRating below min(1)
        [{ query: 'cafe', minRating: 6 }],                // minRating above max(5)
    ] as [Record<string, unknown>][])(
        'G: place_search bad args %j is blocked',
        async (args) => {
            expectBlocked(await executeAlphaTool('place_search', args, 'user-1'))
        },
    )

    // ── H: price_alert bad args (3) ──────────────────────────────────────────

    it.each([
        [{}],                                                       // missing query
        [{ query: 'milk', category: 'electronics' }],              // category not in enum
        [{ query: 'milk', category: 123 }],                        // category wrong type
    ] as [Record<string, unknown>][])(
        'H: price_alert bad args %j is blocked',
        async (args) => {
            expectBlocked(await executeAlphaTool('price_alert', args, 'user-1'))
        },
    )

    // ── I: event_lookup bad args (4) ─────────────────────────────────────────

    it.each([
        [{ location: 'Bangalore' }],                    // missing query
        [{ query: 'concerts' }],                        // missing location (required)
        [{}],                                           // both missing
        [{ query: '', location: 'Bangalore' }],         // empty query
    ] as [Record<string, unknown>][])(
        'I: event_lookup bad args %j is blocked',
        async (args) => {
            expectBlocked(await executeAlphaTool('event_lookup', args, 'user-1'))
        },
    )

    // ── J: friend_activity bad args (2) ──────────────────────────────────────

    it.each([
        [{}],                   // missing friendId
        [{ friendId: '' }],     // empty friendId
    ] as [Record<string, unknown>][])(
        'J: friend_activity bad args %j is blocked',
        async (args) => {
            expectBlocked(await executeAlphaTool('friend_activity', args, 'user-1'))
        },
    )

    // ── K: set_reminder bad args (2) ─────────────────────────────────────────

    it.each([
        [{ time: 'in 30 minutes' }],       // missing message
        [{ message: 'Buy milk' }],         // missing time
    ] as [Record<string, unknown>][])(
        'K: set_reminder bad args %j is blocked',
        async (args) => {
            expectBlocked(await executeAlphaTool('set_reminder', args, 'user-1'))
        },
    )

    // ── L: JSON strings that decode to the wrong schema (2) ─────────────────

    it('L1: JSON string with wrong field type for cab_compare is blocked', async () => {
        // pickup is a number — valid JSON, invalid schema
        expectBlocked(await executeAlphaTool('cab_compare', '{"pickup": 99, "destination": "Airport"}', 'user-1'))
    })

    it('L2: JSON string missing required field for food_finder is blocked', async () => {
        // location is now required; omitting it must fail even when JSON is valid
        expectBlocked(await executeAlphaTool('food_finder', '{"query": "pizza"}', 'user-1'))
    })

    // ── M: Sandbox rate-limit block (1) ──────────────────────────────────────

    it('M: rate-limit exceeded blocks execution before bodyHooks is called', async () => {
        vi.mocked(checkRateLimit).mockResolvedValueOnce(false)
        const result = await executeAlphaTool('weather_check', { location: 'Delhi' }, 'user-1')
        expect(result.success).toBe(false)
        expect(result.error).toContain('Rate limit')
        expect(mockExecuteTool).not.toHaveBeenCalled()
    })
})
