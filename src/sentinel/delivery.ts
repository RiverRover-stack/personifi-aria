/**
 * Sentinel Delivery — Phase 4 (#121)
 *
 * Executes FIRE and BUFFER decisions:
 *
 *   FIRE   → call Alpha to generate a natural proactive message in Aria's voice
 *            → write ProactiveState to DB
 *            → send via Telegram burst
 *   BUFFER → write ProactiveState to DB only (Alpha picks up on next user message)
 *
 * WHY ALPHA GENERATES THE PROACTIVE MESSAGE:
 *   The old approach used stimulus.data.message (a raw template string). This
 *   produced robotic push-notification-style messages that felt nothing like Aria.
 *   Now Sentinel is the INTELLIGENCE layer (decides what to surface) and Alpha
 *   is the VOICE (generates every message the user sees, reactive or proactive).
 *   This means:
 *     - Proactive messages sound like Aria, not like alerts
 *     - Alpha can optionally call an active tool (e.g., fetch live food prices)
 *       to make the proactive message concrete and actionable
 *     - The personality and tone are consistent across all interactions
 */

import { getPool } from '../character/session-store.js'
import { sendProactiveContent } from '../channels.js'
import { upsertProactiveState, updateProactiveStatus } from '../db/fusion-tables.js'
import type { ScoredStimulus, SentinelUserContext } from './types.js'
import { callAlphaProactive } from '../alpha/proactive-alpha.js'
import { logger } from '../logger.js'
import { sendBurst, splitIntoMessages } from '../character/burst-sender.js'

const log = logger.child({ module: 'sentinel/delivery' })

/** Compute expiry: buffers expire after 24 hours */
function expiresIn24h(): Date {
    return new Date(Date.now() + 24 * 60 * 60 * 1000)
}

/**
 * Execute a FIRE decision:
 *   1. Call Alpha to generate a natural proactive message in Aria's voice
 *      (Alpha may optionally call an active tool for enrichment)
 *   2. Write ProactiveState (status = 'active') to DB
 *   3. Send via Telegram burst (typing indicator + 2-part message)
 *   4. Mark ProactiveState as 'delivered' on success, 'error' on failure
 *
 * Returns true if the message was sent successfully.
 */
export async function executeFire(stimulus: ScoredStimulus, ctx: SentinelUserContext): Promise<boolean> {
    const pool = getPool()

    // 1. Call Alpha to generate the proactive message
    //    Falls back to stimulus.data.message if Alpha generation fails
    let message: string
    let toolCalledName: string | undefined
    try {
        const alphaResult = await callAlphaProactive(stimulus.stimulus, ctx)
        message = alphaResult.message
        toolCalledName = alphaResult.toolName
    } catch (err) {
        log.warn({ userId: ctx.userId, stimulus: stimulus.stimulus.type, err }, 'Alpha proactive call failed — using raw stimulus message')
        message = (stimulus.stimulus.data.message as string) ||
            `Hey! ${(stimulus.stimulus.data.suggestedAction as string) || 'Something interesting came up for you.'}`
    }

    // 2. Write ProactiveState to DB BEFORE sending (status = 'active')
    //    This ensures Alpha can pick up the context even if Telegram delivery fails
    await upsertProactiveState(pool, {
        user_id:       ctx.userId,
        stimulus_type: stimulus.stimulus.type,
        stimulus_key:  stimulus.stimulus.key,
        score:         stimulus.compositeScore,
        data:          {
            ...stimulus.stimulus.data,
            // Store what Alpha actually said so reactive handler can reference it
            _proactive_message: message,
            _tool_used:         toolCalledName ?? null,
        },
        result_ref:    null,
        expires_at:    expiresIn24h(),
    })

    // 3. Send via burst (2 messages with typing indicator)
    let sent: boolean
    try {
        const burstMessages = splitIntoMessages(message, 'proactive')
        await sendBurst(ctx.chatId, burstMessages)
        sent = true
    } catch (sendErr) {
        log.warn({ userId: ctx.userId, err: sendErr }, 'Burst send failed — trying single send fallback')
        try {
            sent = await sendProactiveContent(ctx.chatId, message)
        } catch {
            sent = false
        }
    }

    // 4. Update ProactiveState status
    if (sent) {
        await updateProactiveStatus(pool, ctx.userId, stimulus.stimulus.key, 'delivered')
        log.info(
            {
                userId:     ctx.userId,
                key:        stimulus.stimulus.key,
                score:      stimulus.compositeScore,
                toolCalled: !!toolCalledName,
                msgLen:     message.length,
            },
            'Sentinel FIRE delivered via Alpha',
        )
    } else {
        // Mark as error so the cleanup job doesn't retry indefinitely
        // and the daily fire quota isn't consumed by a failed attempt
        await updateProactiveStatus(pool, ctx.userId, stimulus.stimulus.key, 'stale')
        log.warn(
            { userId: ctx.userId, key: stimulus.stimulus.key },
            'Sentinel FIRE — Telegram send failed, marked stale to prevent retry loop',
        )
    }

    return sent
}

/**
 * Execute a BUFFER decision:
 * Write ProactiveState to DB so Alpha can inject context on the next user message.
 *
 * The stimulus stays dormant until the user next messages Aria, at which point
 * fusionReactiveDecision() picks it up and injects it as context for Alpha.
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
    log.debug({ userId: ctx.userId, key: stimulus.stimulus.key, score: stimulus.compositeScore }, 'Sentinel BUFFER written')
}
