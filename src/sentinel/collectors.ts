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
import { processMemoryWriteQueue } from '../archivist/memory-queue.js'
import { checkAndSummarizeSessions } from '../archivist/session-summaries.js'
import { sweepStaleTopics } from '../topic-intent/sweep.js'
import { cleanupExpiredRateLimits } from '../character/session-store.js'

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
export async function collectSocialMonitor(_userId: string): Promise<StimulusInput[]> {
    return []
}

// ─── topic_followup: warm topic re-engagement ────────────────────────────────

/**
 * Stub: collect warm topics that haven't been engaged recently.
 * Was: every-30m cron (runTopicFollowUpsForAllUsers)
 * TODO: expose per-user variant from topic-intent module
 */
export async function collectTopicFollowup(_userId: string): Promise<StimulusInput[]> {
    return []
}

// ─── content_scan: trending + relevant content ───────────────────────────────

/**
 * Stub: collect trending/relevant content stimuli for a user.
 * Was: every-2h + every-6h crons
 * TODO: implement when content intelligence exposes per-user scoring
 */
export async function collectContentScan(_userId: string): Promise<StimulusInput[]> {
    return []
}

// ─── maintenance: memory_process ────────────────────────────────────────────

/**
 * Process the archivist memory write queue.
 * Was: every-30s cron
 */
export async function runMemoryProcess(): Promise<void> {
    await processMemoryWriteQueue(20)
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
