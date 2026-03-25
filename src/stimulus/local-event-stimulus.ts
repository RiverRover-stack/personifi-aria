/**
 * Local Event Stimulus — Phase 5, Issue #135
 *
 * Queries local_events for events within the next 3 days.
 * When the user has interests in user_preferences, ranks events by tag overlap.
 * Returns a StimulusAction with the best matching event; null if none found.
 */

import { getPool } from '../character/session-store.js'
import { logger as rootLogger } from '../logger.js'
import type { StimulusAction } from './stimulus-router.js'

const log = rootLogger.child({ module: 'local-event-stimulus' })

// ─── Types ────────────────────────────────────────────────────────────────────

interface LocalEventRow {
    id: string
    event_name: string
    venue: string | null
    event_date: Date | null
    description: string | null
    tags: string[] | null
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function getUserInterests(userId: string): Promise<string[]> {
    try {
        const pool = getPool()
        const { rows } = await pool.query<{ value: string }>(
            `SELECT value FROM user_preferences
             WHERE user_id = $1 AND category = 'interests'
             LIMIT 1`,
            [userId]
        )
        const raw = rows[0]?.value ?? ''
        return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    } catch {
        return []
    }
}

async function getUpcomingEvents(): Promise<LocalEventRow[]> {
    try {
        const pool = getPool()
        const { rows } = await pool.query<LocalEventRow>(
            `SELECT id, event_name, venue, event_date, description, tags
             FROM local_events
             WHERE event_date BETWEEN NOW() AND NOW() + INTERVAL '3 days'
             ORDER BY event_date ASC
             LIMIT 20`
        )
        return rows
    } catch {
        return []
    }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function scoreEvent(event: LocalEventRow, interests: string[]): number {
    if (interests.length === 0) return 1
    const tags = event.tags ?? []
    const overlap = tags.filter(t => interests.includes(t.toLowerCase())).length
    return overlap
}

// ─── Message builder ──────────────────────────────────────────────────────────

function buildMessage(event: LocalEventRow): string {
    const when = event.event_date
        ? new Date(event.event_date).toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' })
        : 'upcoming'
    const where = event.venue ? ` at ${event.venue}` : ''
    return `${event.event_name}${where} — ${when} 🎉 Want details?`
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function getLocalEventStimulus(userId: string): Promise<StimulusAction | null> {
    const [events, interests] = await Promise.all([
        getUpcomingEvents(),
        getUserInterests(userId),
    ])

    if (events.length === 0) return null

    // Rank by interest overlap; pick top match
    const scored = events.map(e => ({ event: e, score: scoreEvent(e, interests) }))
    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]

    // If user has interests but no overlap, skip (score = 0 means no relevance)
    if (interests.length > 0 && best.score === 0) return null

    const event = best.event
    log.debug({ userId, event_name: event.event_name, score: best.score }, 'Local event stimulus ready')

    return {
        type: 'event',
        priority: 3,
        message: buildMessage(event),
        suggestedAction: 'show_event_details',
        hashtag: (event.tags ?? [])[0] ?? 'localEvents',
        raw: { ...event, updatedAt: Date.now() } as any,
    }
}
