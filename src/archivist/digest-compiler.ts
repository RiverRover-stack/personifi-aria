/**
 * Digest Compiler — compiles weekly session summaries into a permanent digest.
 * Runs once per week per user (idempotent).
 */

import { getPool } from '../character/session-store.js'
import { generateResponse } from '../llm/tierManager.js'
import { addToGraph } from '../graph-memory.js'
import { logger } from '../logger.js'

const log = logger.child({ module: 'archivist/digest-compiler' })

const DIGEST_PROMPT = `You are Aria's long-term memory system. Compile the session summaries below into a single compact narrative of 150-200 words.

Focus on:
- Key plans, decisions, and intentions the user expressed
- Important preferences or facts revealed
- Emotional tone and recurring themes
- People, places, and things mentioned with sentiment

Write from Aria's perspective. Be specific and factual. Return ONLY the narrative text.`

/**
 * Compile a weekly digest for a user from their session_summaries.
 * Idempotent — skips if a digest already exists for this week.
 */
export async function compileWeeklyDigest(userId: string): Promise<void> {
    const pool = getPool()

    // Compute week boundaries (Monday–Sunday)
    const now = new Date()
    const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay() // 1=Mon, 7=Sun
    const weekStart = new Date(now)
    weekStart.setDate(now.getDate() - dayOfWeek + 1)
    weekStart.setHours(0, 0, 0, 0)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 6)

    const weekStartStr = weekStart.toISOString().split('T')[0]
    const weekEndStr = weekEnd.toISOString().split('T')[0]

    // Idempotency check
    const { rows: existing } = await pool.query(
        `SELECT id FROM weekly_digests WHERE user_id = $1 AND week_start = $2`,
        [userId, weekStartStr],
    )
    if (existing.length > 0) return

    // Collect session summaries from the past 7 days
    const { rows: summaries } = await pool.query<{ summary_text: string; created_at: Date }>(
        `SELECT summary_text, created_at
         FROM session_summaries
         WHERE user_id = $1
           AND created_at >= $2
           AND created_at < $3
         ORDER BY created_at ASC`,
        [userId, weekStartStr, weekEndStr],
    )

    if (summaries.length === 0) return

    const combinedText = summaries.map(s => s.summary_text).join('\n\n---\n\n')

    // Generate compact digest
    const { text: digestText } = await generateResponse([
        { role: 'system', content: DIGEST_PROMPT },
        { role: 'user', content: `Compile these summaries:\n\n${combinedText.slice(0, 4000)}` },
    ], { maxTokens: 300, temperature: 0.3 })

    if (!digestText) return

    // Count plans for this week
    const { rows: planRows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM conversation_plans
         WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
        [userId, weekStartStr, weekEndStr],
    )
    const planCount = parseInt(planRows[0]?.count ?? '0', 10)

    // Write digest
    await pool.query(
        `INSERT INTO weekly_digests (user_id, week_start, week_end, digest_text, plan_count)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, week_start) DO NOTHING`,
        [userId, weekStartStr, weekEndStr, digestText, planCount],
    )

    // Update entity graph from digest (fire-and-forget)
    addToGraph(userId, digestText).catch(err =>
        log.warn({ err, userId }, 'Graph update from digest failed')
    )

    log.info({ userId, weekStart: weekStartStr, summaryCount: summaries.length }, 'Weekly digest compiled')
}
