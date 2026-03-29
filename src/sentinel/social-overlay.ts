/**
 * Sentinel Social Overlay — Phase 4 (#121)
 *
 * Applies a squad-convergence score boost to stimuli.
 * If 3+ friends are interested in the same topic → ×1.3 boost.
 * If an active squad discussion is happening → additional +0.10 boost.
 */

import type { Pool } from 'pg'
import type { ScoredStimulus } from './types.js'
import { getPool } from '../character/session-store.js'
import { SOCIAL_CONVERGENCE_BOOST, SOCIAL_SQUAD_BOOST } from './constants.js'

/**
 * Apply social overlay to a scored stimulus.
 * Returns the same stimulus with compositeScore multiplied by the boost.
 */
export async function applySocialOverlay(stimulus: ScoredStimulus): Promise<ScoredStimulus> {
    try {
        const pool = getPool()
        const boost = await getSquadConvergenceBoost(pool, stimulus.userId, stimulus.stimulus.type)
        if (boost > 1.0) {
            return {
                ...stimulus,
                compositeScore: Math.min(stimulus.compositeScore * boost, 1.0),
                socialBoost: boost,
            }
        }
    } catch {
        // Non-fatal — return unmodified stimulus
    }
    return { ...stimulus, socialBoost: 1.0 }
}

async function getSquadConvergenceBoost(pool: Pool, userId: string, stimulusType: string): Promise<number> {
    // Get user's squads
    const { rows: squadRows } = await pool.query<{ squad_id: string }>(
        `SELECT squad_id FROM squad_members WHERE user_id = $1`,
        [userId],
    )
    if (squadRows.length === 0) return 1.0

    let maxBoost = 1.0

    for (const { squad_id: squadId } of squadRows) {
        // Get squad members (excluding self)
        const { rows: memberRows } = await pool.query<{ user_id: string }>(
            `SELECT user_id FROM squad_members WHERE squad_id = $1 AND user_id != $2`,
            [squadId, userId],
        )
        if (memberRows.length === 0) continue

        const memberIds = memberRows.map(r => r.user_id)

        // Count members with overlapping topic_intents in last 48h
        const { rows: intentRows } = await pool.query<{ count: string }>(
            `SELECT COUNT(DISTINCT user_id) AS count
             FROM topic_intents
             WHERE user_id = ANY($1)
               AND topic ILIKE $2
               AND created_at > NOW() - INTERVAL '48 hours'`,
            [memberIds, `%${stimulusType}%`],
        )

        const convergingCount = parseInt(intentRows[0]?.count ?? '0', 10)

        if (convergingCount >= 3) {
            // Check for active squad discussion (signal_packets in last 60 min)
            const { rows: activeRows } = await pool.query<{ count: string }>(
                `SELECT COUNT(DISTINCT user_id) AS count
                 FROM signal_packets
                 WHERE user_id = ANY($1)
                   AND created_at > NOW() - INTERVAL '60 minutes'`,
                [memberIds],
            )
            const activeCount = parseInt(activeRows[0]?.count ?? '0', 10)
            const boost = SOCIAL_CONVERGENCE_BOOST + (activeCount >= 2 ? SOCIAL_SQUAD_BOOST : 0)
            if (boost > maxBoost) maxBoost = boost
        }
    }

    return maxBoost
}
