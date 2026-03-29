/**
 * Sentinel State Store — Phase 4 (#121)
 *
 * DB CRUD for per-user Sentinel state, backed by:
 *   - proactive_user_state  (migration 001 + 006)
 *   - pulse_engagement_scores (migration 004)
 */

import type { Pool } from 'pg'
import type { SentinelUserContext, SentinelMode } from './types.js'
import { loadPreferences } from '../memory.js'
import { logger as rootLogger } from '../logger.js'

const log = rootLogger.child({ module: 'sentinel/state-store' })

// 5-minute TTL cache for hydrated preferences — keyed by userId, never cross-user
const prefCache = new Map<string, { prefs: Record<string, string>; expiresAt: number }>()

/** Evict expired preference cache entries to prevent unbounded growth at scale */
function evictPrefCache(): void {
    const now = Date.now()
    for (const [userId, entry] of prefCache) {
        if (entry.expiresAt <= now) prefCache.delete(userId)
    }
}

interface SentinelUserRow {
    user_id: string
    chat_id: string
    display_name: string | null
    pulse_score: string
    pulse_state: string
    sentinel_mode: string | null
    daily_fire_count: string
    last_fire_at: string | null
    last_reset_date: string | null
    pushback_count: string
    consecutive_positive: string
    /** Epoch seconds of user's most recent session message — NULL if no session yet */
    last_active_epoch: string | null
}

/**
 * Load all onboarded users with their full Sentinel context.
 * Only users who have a proactive_user_state row (i.e., chat_id known) are returned.
 *
 * lastActiveAt is pulled from the user's most recently active session so the
 * decision engine can suppress FIRE during active conversations.
 */
export async function loadSentinelUsersWithContext(pool: Pool): Promise<SentinelUserContext[]> {
    const { rows } = await pool.query<SentinelUserRow>(`
        SELECT
            u.user_id,
            pus.chat_id,
            u.display_name,
            COALESCE(pes.engagement_score, 30)::text              AS pulse_score,
            COALESCE(pes.current_state,    'CURIOUS')             AS pulse_state,
            pus.sentinel_mode,
            COALESCE(pus.send_count_today, 0)::text               AS daily_fire_count,
            EXTRACT(EPOCH FROM pus.last_sent_at)::text            AS last_fire_at,
            TO_CHAR(pus.last_reset_date, 'YYYY-MM-DD')            AS last_reset_date,
            COALESCE(pus.pushback_count, 0)::text                 AS pushback_count,
            COALESCE(pus.consecutive_positive, 0)::text           AS consecutive_positive,
            EXTRACT(EPOCH FROM (
                SELECT MAX(s.last_active)
                FROM sessions s
                WHERE s.user_id = u.user_id
            ))::text AS last_active_epoch
        FROM users u
        INNER JOIN proactive_user_state pus ON pus.user_id = u.user_id
        LEFT  JOIN pulse_engagement_scores pes ON pes.user_id = u.user_id
        WHERE u.authenticated = TRUE
          AND u.onboarding_complete = TRUE
    `)

    const baseUsers = rows.map(row => ({
        userId:              row.user_id,
        chatId:              row.chat_id,
        displayName:         row.display_name ?? null,
        pulseState:          (row.pulse_state as SentinelUserContext['pulseState']) ?? 'CURIOUS',
        pulseScore:          Number(row.pulse_score) || 30,
        mode:                (row.sentinel_mode as SentinelMode) ?? 'REACTIVE',
        dailyFireCount:      Number(row.daily_fire_count) || 0,
        lastFireAt:          row.last_fire_at ? Number(row.last_fire_at) * 1000 : 0,
        lastResetDate:       row.last_reset_date ?? '',
        pushbackCount:       Number(row.pushback_count) || 0,
        consecutivePositive: Number(row.consecutive_positive) || 0,
        preferences:         {},
        lastActiveAt:        row.last_active_epoch ? Number(row.last_active_epoch) * 1000 : 0,
    }))

    // Hydrate preferences for all users in parallel (5-min TTL cache)
    const now = Date.now()
    await Promise.all(baseUsers.map(async user => {
        const cached = prefCache.get(user.userId)
        if (cached && cached.expiresAt > now) {
            user.preferences = cached.prefs
            return
        }
        try {
            const prefs = await loadPreferences(pool, user.userId)
            const prefCount = Object.keys(prefs).length
            log.debug({ userId: user.userId, prefCount }, 'Hydrated preferences')
            user.preferences = prefs as Record<string, string>
            prefCache.set(user.userId, { prefs: user.preferences, expiresAt: now + 5 * 60 * 1000 })
        } catch (err) {
            log.warn({ userId: user.userId, err }, 'Failed to hydrate preferences')
        }
    }))

    return baseUsers
}

/** Persist the Sentinel mode (PROACTIVE / REACTIVE) for a user */
export async function saveSentinelMode(pool: Pool, userId: string, mode: SentinelMode): Promise<void> {
    await pool.query(
        `UPDATE proactive_user_state
         SET sentinel_mode = $2, updated_at = NOW()
         WHERE user_id = $1`,
        [userId, mode]
    )
}

/** Increment the daily fire counter and record the time of last FIRE */
export async function incrementDailyFire(pool: Pool, userId: string): Promise<void> {
    await pool.query(
        `UPDATE proactive_user_state
         SET send_count_today = send_count_today + 1,
             last_sent_at     = NOW(),
             updated_at       = NOW()
         WHERE user_id = $1`,
        [userId]
    )
}

/**
 * Reset send_count_today if it belongs to a different calendar day (IST).
 * Called at the start of every user's processing in a tick.
 */
export async function resetDailyCountsIfNeeded(
    pool: Pool,
    userId: string,
    currentDateIST: string
): Promise<void> {
    await pool.query(
        `UPDATE proactive_user_state
         SET send_count_today = 0,
             last_reset_date  = $2::date,
             updated_at       = NOW()
         WHERE user_id = $1
           AND (last_reset_date IS NULL OR last_reset_date < $2::date)`,
        [userId, currentDateIST]
    )
}

/** Record a positive interaction (increments consecutive_positive) */
export async function recordPositiveInteractionDB(pool: Pool, userId: string): Promise<void> {
    await pool.query(
        `UPDATE proactive_user_state
         SET consecutive_positive = consecutive_positive + 1,
             updated_at           = NOW()
         WHERE user_id = $1`,
        [userId]
    )
}

/** Record a pushback — increments pushback_count and resets consecutive_positive */
export async function recordPushbackDB(pool: Pool, userId: string): Promise<void> {
    await pool.query(
        `UPDATE proactive_user_state
         SET pushback_count       = pushback_count + 1,
             consecutive_positive = 0,
             updated_at           = NOW()
         WHERE user_id = $1`,
        [userId]
    )
}

/**
 * Ensure a proactive_user_state row exists for the user.
 * Called after onboarding completes so Sentinel can process them.
 * Idempotent — safe to call on every authenticated message.
 *
 * @param chatId  The Telegram chat ID for sending proactive messages
 */
export async function ensureProactiveUserState(
    pool: Pool,
    userId: string,
    chatId: string,
): Promise<void> {
    await pool.query(
        `INSERT INTO proactive_user_state (user_id, chat_id, sentinel_mode)
         VALUES ($1, $2, 'REACTIVE')
         ON CONFLICT (user_id) DO UPDATE
             SET chat_id    = EXCLUDED.chat_id,
                 updated_at = NOW()
         WHERE proactive_user_state.chat_id IS DISTINCT FROM EXCLUDED.chat_id`,
        [userId, chatId],
    )
}
