/**
 * Sentinel Collectors — Phase 4 (#121)
 *
 * Thin adapters that wrap existing subsystems and return StimulusInput[]
 * (the fusion type) so the Sentinel loop can score them uniformly.
 *
 * Each collector maps to one of the old cron job categories.
 * Errors are always caught — a failed collector returns [] and never
 * crashes the Sentinel loop.
 */

import type { StimulusInput } from '../fusion/types.js'
import { getPersonalizedStimuli } from '../stimulus/stimulus-router.js'
import { getMessMenuStimulus } from '../stimulus/mess-menu-stimulus.js'
import { getLocalEventStimulus } from '../stimulus/local-event-stimulus.js'
import { processMemoryWriteQueue } from '../archivist/memory-queue.js'
import { checkAndSummarizeSessions } from '../archivist/session-summaries.js'
import { sweepStaleTopics } from '../topic-intent/sweep.js'
import { cleanupExpiredRateLimits } from '../character/session-store.js'
import { getPool } from '../character/session-store.js'

// ─── stimulus_refresh: weather / traffic / festival ──────────────────────────

/**
 * Collect weather, traffic, and festival stimuli for a user.
 * Maps StimulusAction (from stimulus-router) → StimulusInput (fusion type).
 * Was: every-30m cron × 3 separate jobs
 */
export async function collectStimulusRefresh(userId: string): Promise<StimulusInput[]> {
    try {
        const actions = await getPersonalizedStimuli(userId)
        return actions.map(action => ({
            type: action.type,
            key:  `${action.type}_${action.hashtag}_${action.priority}`,
            // Base weight from sentinel-soul.md: weather=0.9, traffic=0.85, festival=0.6
            weight: action.type === 'weather' ? 0.9 : action.type === 'traffic' ? 0.85 : 0.6,
            data: {
                message:         action.message,
                suggestedAction: action.suggestedAction,
                hashtag:         action.hashtag,
                priority:        action.priority,
                raw:             action.raw,
            },
        }))
    } catch {
        return []
    }
}

// ─── social_monitor: squad convergence / friend graph changes ─────────────────

/**
 * Stub: collect social convergence stimuli for a user.
 * Was: every-15m + every-30m crons
 * TODO: implement squad graph query when social module exposes per-user API
 */
export async function collectSocialMonitor(userId: string): Promise<StimulusInput[]> {
    try {
        const pool = getPool()

        // Get user's squad IDs
        const { rows: squadRows } = await pool.query<{ squad_id: string }>(
            `SELECT squad_id FROM squad_members WHERE user_id = $1`,
            [userId],
        )
        if (squadRows.length === 0) return []

        const results: StimulusInput[] = []
        const now = new Date()
        const dateHour = `${now.toISOString().slice(0, 13)}`

        for (const { squad_id: squadId } of squadRows) {
            // Get squad members (excluding self)
            const { rows: memberRows } = await pool.query<{ user_id: string }>(
                `SELECT user_id FROM squad_members WHERE squad_id = $1 AND user_id != $2`,
                [squadId, userId],
            )
            // Need at least 1 other member (besides self) to detect convergence.
            // The previous `< 2` check was wrong — it skipped all 2-person squads.
            if (memberRows.length < 1) continue

            const memberIds = memberRows.map(r => r.user_id)

            // Query signal_packets for recent activity (last 60 minutes)
            const { rows: signalRows } = await pool.query<{ user_id: string; current_direction: string | null }>(
                `SELECT user_id, current_direction
                 FROM signal_packets
                 WHERE user_id = ANY($1)
                   AND created_at > NOW() - INTERVAL '60 minutes'
                   AND current_direction IS NOT NULL`,
                [memberIds],
            )

            if (signalRows.length < 2) continue

            // Simple overlap check: find words > 4 chars in common between any two directions
            const directions = signalRows.map(r => r.current_direction!.toLowerCase().split(/\s+/).filter(w => w.length > 4))
            let overlappingTopic: string | null = null

            outer: for (let i = 0; i < directions.length; i++) {
                for (let j = i + 1; j < directions.length; j++) {
                    const common = directions[i].filter(w => directions[j].includes(w))
                    if (common.length > 0) {
                        overlappingTopic = common[0]
                        break outer
                    }
                }
            }

            if (!overlappingTopic) continue

            results.push({
                type: 'social_convergence',
                key: `social_convergence_squad_${squadId}_${dateHour}`,
                weight: 0.70,
                data: {
                    squad_id: squadId,
                    topic: overlappingTopic,
                    active_count: signalRows.length,
                },
            })
        }

        return results
    } catch {
        return []
    }
}

// ─── topic_followup: warm topic re-engagement ────────────────────────────────

/**
 * Collect warm topics that haven't been engaged recently.
 * Was: every-30m cron (runTopicFollowUpsForAllUsers)
 */
export async function collectTopicFollowup(userId: string): Promise<StimulusInput[]> {
    try {
        const pool = getPool()
        const { rows } = await pool.query<{
            id: string
            topic: string
            category: string | null
            strategy: string | null
            phase: string
            last_signal_at: Date
            created_at: Date
        }>(
            `SELECT id, topic, category, strategy, phase, last_signal_at, created_at
             FROM topic_intents
             WHERE user_id = $1
               AND phase IN ('active', 'pending')
               AND created_at > NOW() - INTERVAL '7 days'
             ORDER BY last_signal_at DESC
             LIMIT 10`,
            [userId],
        )

        const stimuli: StimulusInput[] = []
        const now = Date.now()

        for (const row of rows) {
            const createdMs = new Date(row.created_at).getTime()
            const lastSignalMs = new Date(row.last_signal_at).getTime()
            const ageDays = (now - createdMs) / (1000 * 60 * 60 * 24)
            const hoursSinceSignal = (now - lastSignalMs) / (1000 * 60 * 60)

            const shouldFire =
                (row.phase === 'pending' && ageDays > 3) ||
                (row.strategy === 'time_sensitive' && hoursSinceSignal > 24)

            if (!shouldFire) continue

            stimuli.push({
                type: 'topic_followup',
                key: `topic_followup_${row.id}`,
                weight: 0.60,
                data: {
                    topic: row.topic,
                    category: row.category ?? 'other',
                    strategy: row.strategy ?? 'standard',
                },
            })

            if (stimuli.length >= 2) break
        }

        return stimuli
    } catch {
        return []
    }
}

// ─── plan_reminder: upcoming plan nudges ─────────────────────────────────────

/**
 * Collect plan reminders from conversation_plans.
 * Fires 1-2 days before scheduled_for, or 5 days after creation if no date.
 */
export async function collectPlanReminders(userId: string): Promise<StimulusInput[]> {
    try {
        const pool = getPool()
        const { rows } = await pool.query<{
            id: string
            plan_type: string
            description: string
            scheduled_for: string | null
            created_at: Date
        }>(
            `SELECT id, plan_type, description, scheduled_for, created_at
             FROM conversation_plans
             WHERE user_id = $1
               AND status = 'pending'
               AND expires_at > NOW()`,
            [userId],
        )

        const stimuli: StimulusInput[] = []
        const now = Date.now()

        for (const row of rows) {
            let shouldFire = false

            if (row.scheduled_for) {
                const scheduledMs = new Date(row.scheduled_for).getTime()
                const daysUntil = (scheduledMs - now) / (1000 * 60 * 60 * 24)
                shouldFire = daysUntil >= 0 && daysUntil < 2
            } else {
                const createdMs = new Date(row.created_at).getTime()
                const ageDays = (now - createdMs) / (1000 * 60 * 60 * 24)
                shouldFire = ageDays >= 5
            }

            if (!shouldFire) continue

            stimuli.push({
                type: 'plan_reminder',
                key: `plan_reminder_${row.id}`,
                weight: 0.75,
                data: {
                    description: row.description,
                    plan_type: row.plan_type,
                    scheduled_for: row.scheduled_for ?? null,
                },
            })
        }

        return stimuli
    } catch {
        return []
    }
}

// ─── interest_intent: topic interest follow-up ───────────────────────────────

/**
 * Collect interest intents from session_summaries with has_topic_interest flag.
 */
export async function collectInterestIntents(userId: string): Promise<StimulusInput[]> {
    try {
        const pool = getPool()
        const { rows } = await pool.query<{ id: string }>(
            `SELECT id FROM session_summaries
             WHERE user_id = $1
               AND created_at > NOW() - INTERVAL '7 days'
               AND metadata->>'has_topic_interest' = 'true'
             ORDER BY created_at DESC
             LIMIT 2`,
            [userId],
        )

        return rows.map(row => ({
            type: 'interest_intent',
            key: `interest_${row.id}`,
            weight: 0.55,
            data: { session_summary_id: row.id },
        }))
    } catch {
        return []
    }
}

// ─── content_scan: trending + relevant content ───────────────────────────────

/**
 * Stub: collect trending/relevant content stimuli for a user.
 * Was: every-2h + every-6h crons
 * TODO: implement when content intelligence exposes per-user scoring
 */
export function collectContentScan(_userId: string): Promise<StimulusInput[]> {
    return Promise.resolve([])
}

// ─── maintenance: memory_process ────────────────────────────────────────────

/**
 * Process the archivist memory write queue.
 * Was: every-30s cron
 */
export async function runMemoryProcess(): Promise<void> {
    await processMemoryWriteQueue(20)
}

// ─── mess_menu: hostel meal stimulus ─────────────────────────────────────────

/**
 * Collect hostel mess menu stimulus for a user.
 * Returns a StimulusInput when the current time falls within a meal window
 * and the user's hostel has a menu for today. Returns [] otherwise.
 * Phase 5, Issue #135.
 */
export async function collectMessMenu(userId: string): Promise<StimulusInput[]> {
    try {
        const action = await getMessMenuStimulus(userId)
        if (!action) return []
        return [{
            type:   action.type,
            key:    `mess_menu_${action.hashtag}_${action.priority}`,
            weight: 0.5,
            data: {
                message:         action.message,
                suggestedAction: action.suggestedAction,
                hashtag:         action.hashtag,
                priority:        action.priority,
                raw:             action.raw,
            },
        }]
    } catch {
        return []
    }
}

// ─── local_event: nearby upcoming events ─────────────────────────────────────

/**
 * Collect local event stimulus for a user.
 * Returns the highest-interest-matched event within the next 3 days.
 * Returns [] when no events match the user's interests or none are upcoming.
 * Phase 5, Issue #135.
 */
export async function collectLocalEvents(userId: string): Promise<StimulusInput[]> {
    try {
        const action = await getLocalEventStimulus(userId)
        if (!action) return []
        return [{
            type:   action.type,
            key:    `local_event_${action.hashtag}_${action.priority}`,
            weight: 0.6,
            data: {
                message:         action.message,
                suggestedAction: action.suggestedAction,
                hashtag:         action.hashtag,
                priority:        action.priority,
                raw:             action.raw,
            },
        }]
    } catch {
        return []
    }
}

// ─── maintenance: session_cleanup ───────────────────────────────────────────

/**
 * Run all session maintenance tasks.
 * Was: every-5m cron (session summarization) + every-1h crons (stale topics + rate limits)
 */
export async function runSessionCleanup(): Promise<void> {
    await Promise.allSettled([
        checkAndSummarizeSessions(),
        sweepStaleTopics(),
        cleanupExpiredRateLimits(),
    ])
}

// ─── maintenance: session_pruner (weekly) ────────────────────────────────────

/**
 * Compile weekly digests and prune old sessions for all users.
 * Runs once per week via the Sentinel loop (every 10080 ticks).
 * Processes users in small batches to avoid DB overload.
 */
export async function runSessionPruner(): Promise<void> {
    const pool = getPool()
    try {
        // Fetch all user IDs that have session summaries older than 7 days
        const { rows } = await pool.query<{ user_id: string }>(
            `SELECT DISTINCT user_id FROM session_summaries
             WHERE created_at < NOW() - INTERVAL '7 days'
             LIMIT 200`,
        )
        if (rows.length === 0) return

        const { pruneOldSessions } = await import('../archivist/session-pruner.js')
        // Process in batches of 10 to avoid hammering the LLM API
        for (let i = 0; i < rows.length; i += 10) {
            const batch = rows.slice(i, i + 10)
            await Promise.allSettled(batch.map(r => pruneOldSessions(r.user_id)))
        }
    } catch (err) {
        // Never crash the Sentinel loop
        const log = (await import('../logger.js')).logger.child({ module: 'sentinel/collectors' })
        log.error({ err }, 'runSessionPruner failed')
    }
}
