/**
 * Session Pruner — removes old sessions and summaries after digest compilation.
 * Never deletes unsummarized sessions.
 */

import { getPool } from '../character/session-store.js'
import { compileWeeklyDigest } from './digest-compiler.js'
import { logger } from '../logger.js'

const log = logger.child({ module: 'archivist/session-pruner' })

/**
 * Prune old sessions and summaries for a user.
 * Only deletes sessions that have been summarized and are older than 7 days.
 * Compiles weekly digest before deleting summaries.
 */
export async function pruneOldSessions(userId: string): Promise<void> {
    const pool = getPool()

    try {
        // Compile weekly digest first (idempotent)
        await compileWeeklyDigest(userId)
    } catch (err) {
        log.warn({ err, userId }, 'Digest compilation failed — skipping prune to avoid data loss')
        return
    }

    try {
        // Delete summarized sessions older than 7 days
        const { rowCount: sessionsDeleted } = await pool.query(
            `DELETE FROM sessions
             WHERE user_id = $1
               AND updated_at < NOW() - INTERVAL '7 days'
               AND EXISTS (
                   SELECT 1 FROM session_summaries ss
                   WHERE ss.session_id = sessions.session_id
               )`,
            [userId],
        )

        // Delete session_summaries older than 7 days (digest was compiled above)
        const { rowCount: summariesDeleted } = await pool.query(
            `DELETE FROM session_summaries
             WHERE user_id = $1
               AND created_at < NOW() - INTERVAL '7 days'`,
            [userId],
        )

        if ((sessionsDeleted ?? 0) > 0 || (summariesDeleted ?? 0) > 0) {
            log.info({ userId, sessionsDeleted, summariesDeleted }, 'Old sessions pruned')
        }
    } catch (err) {
        log.error({ err, userId }, 'Session pruning failed')
    }
}
