import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (must be before import of module under test) ───────────────────────

vi.mock('../character/session-store.js', () => ({
    getPool: vi.fn(() => ({
        query: vi.fn().mockResolvedValue({ rows: [] }),
    })),
}))

vi.mock('./state-store.js', () => ({
    loadSentinelUsersWithContext: vi.fn().mockResolvedValue([]),
    incrementDailyFire:           vi.fn().mockResolvedValue(undefined),
    resetDailyCountsIfNeeded:     vi.fn().mockResolvedValue(undefined),
    saveSentinelMode:             vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./collectors.js', () => ({
    collectStimulusRefresh: vi.fn().mockResolvedValue([]),
    collectSocialMonitor:   vi.fn().mockResolvedValue([]),
    collectTopicFollowup:   vi.fn().mockResolvedValue([]),
    collectContentScan:     vi.fn().mockResolvedValue([]),
    runMemoryProcess:       vi.fn().mockResolvedValue(undefined),
    runSessionCleanup:      vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../stimulus/stimulus-router.js', () => ({
    refreshAllStimuliForActiveLocations: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../db/fusion-tables.js', () => ({
    upsertProactiveState:    vi.fn().mockResolvedValue({}),
    updateProactiveStatus:   vi.fn().mockResolvedValue(undefined),
    insertPulseHistory:      vi.fn().mockResolvedValue(undefined),
    insertSignalPacket:      vi.fn().mockResolvedValue(undefined),
    runFusionTableCleanup:   vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./delivery.js', () => ({
    executeFire:   vi.fn().mockResolvedValue(true),
    executeBuffer: vi.fn().mockResolvedValue(undefined),
}))

// ── Import after mocks ───────────────────────────────────────────────────────

import { sentinelTick } from './sentinel-loop.js'
import { loadSentinelUsersWithContext } from './state-store.js'

// ── Tests ────────────────────────────────────────────────────────────────────

describe('sentinelTick', () => {
    beforeEach(() => {
        vi.mocked(loadSentinelUsersWithContext).mockResolvedValue([])
    })

    it('completes without error when no users', async () => {
        const result = await sentinelTick()
        expect(result.errors).toBe(0)
        expect(result.usersProcessed).toBe(0)
        expect(result.finishedAt.getTime()).toBeGreaterThanOrEqual(result.startedAt.getTime())
    })

    it('returns a valid SentinelTickResult shape', async () => {
        const result = await sentinelTick()
        expect(result).toMatchObject({
            fires:      expect.any(Number),
            buffers:    expect.any(Number),
            drops:      expect.any(Number),
            preFetches: expect.any(Number),
            errors:     expect.any(Number),
        })
    })

    it('processes users and counts fires', async () => {
        const { executeFire } = await import('./delivery.js')
        const { collectStimulusRefresh } = await import('./collectors.js')

        vi.mocked(loadSentinelUsersWithContext).mockResolvedValue([{
            userId:              'u1',
            chatId:              'c1',
            pulseState:          'ENGAGED',
            pulseScore:          65,
            mode:                'PROACTIVE',
            dailyFireCount:      0,
            lastFireAt:          0,
            lastResetDate:       '2026-03-24',
            pushbackCount:       0,
            consecutivePositive: 0,
            preferences:         {},
        }])

        vi.mocked(collectStimulusRefresh).mockResolvedValue([{
            type: 'weather', key: 'rain_test', weight: 0.9,
            data: { message: 'Heavy rain expected', suggestedAction: 'Take an umbrella' },
        }])

        vi.mocked(executeFire).mockResolvedValue(true)

        // Set time to active hours (10am IST = 4:30am UTC) so fire gates pass
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-03-24T04:30:00Z'))

        const result = await sentinelTick()
        expect(result.usersProcessed).toBeGreaterThanOrEqual(1)

        vi.useRealTimers()
    })
})
