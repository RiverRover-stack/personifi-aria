/**
 * Sentinel Delivery — Phase 4 (#121)
 *
 * Executes FIRE and BUFFER decisions:
 *   FIRE   → write ProactiveState to DB + send Telegram message
 *   BUFFER → write ProactiveState to DB only (Alpha picks up on next user message)
 */

import { getPool } from '../character/session-store.js'
import { sendProactiveContent } from '../channels.js'
import { upsertProactiveState, updateProactiveStatus } from '../db/fusion-tables.js'
import type { ScoredStimulus, SentinelUserContext } from './types.js'
import { logger } from '../logger.js'

const log = logger.child({ module: 'sentinel/delivery' })

/** Compute expiry: buffers expire after 24 hours */
function expiresIn24h(): Date {
    return new Date(Date.now() + 24 * 60 * 60 * 1000)
}

/**
 * Execute a FIRE decision:
 * 1. Write ProactiveState (status = 'active') to DB
 * 2. Build and send a Telegram message from the stimulus payload
 * 3. Mark ProactiveState as 'delivered' on success
 *
 * Returns true if the message was sent successfully.
 */
export async function executeFire(stimulus: ScoredStimulus, ctx: SentinelUserContext): Promise<boolean> {
    const pool = getPool()

    // 1. Write ProactiveState
    await upsertProactiveState(pool, {
        user_id:       ctx.userId,
        stimulus_type: stimulus.stimulus.type,
        stimulus_key:  stimulus.stimulus.key,
        score:         stimulus.compositeScore,
        data:          stimulus.stimulus.data,
        result_ref:    null,
        expires_at:    expiresIn24h(),
    })

    // 2. Build message from stimulus payload
    const data = stimulus.stimulus.data
    const message = (data.message as string) ||
        `Hey! ${(data.suggestedAction as string) || 'I found something interesting for you.'}`

    // 3. Send via Telegram
    const sent = await sendProactiveContent(ctx.chatId, message)

    if (sent) {
        // Mark delivered
        await updateProactiveStatus(pool, ctx.userId, stimulus.stimulus.key, 'delivered')
        log.info({ userId: ctx.userId, key: stimulus.stimulus.key, score: stimulus.compositeScore }, 'Sentinel FIRE delivered')
    } else {
        log.warn({ userId: ctx.userId, key: stimulus.stimulus.key }, 'Sentinel FIRE — Telegram send failed')
    }

    return sent
}

/**
 * Execute a BUFFER decision:
 * Write ProactiveState to DB so Alpha can inject context on the next user message.
 */
export async function executeBuffer(stimulus: ScoredStimulus, ctx: SentinelUserContext): Promise<void> {
    const pool = getPool()
    await upsertProactiveState(pool, {
        user_id:       ctx.userId,
        stimulus_type: stimulus.stimulus.type,
        stimulus_key:  stimulus.stimulus.key,
        score:         stimulus.compositeScore,
        data:          stimulus.stimulus.data,
        result_ref:    null,
        expires_at:    expiresIn24h(),
    })
    log.debug({ userId: ctx.userId, key: stimulus.stimulus.key }, 'Sentinel BUFFER written')
}
