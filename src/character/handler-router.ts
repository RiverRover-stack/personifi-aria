/**
 * Handler Router — Feature Flag Switch (Issue #124)
 *
 * Selects between the new Alpha 5-step handler and the legacy 22-step handler
 * based on the ALPHA_HANDLER_ENABLED environment variable.
 *
 *   ALPHA_HANDLER_ENABLED=false (default) → handler-legacy.ts (22-step, battle-tested)
 *   ALPHA_HANDLER_ENABLED=true            → handler-alpha.ts  (5-step Alpha pipeline)
 *
 * Instant rollback: flip env var back to false and restart — no code changes needed.
 *
 * This file is the NEW handler.ts entry point re-exported from character/index.ts.
 */

import { logger as rootLogger } from '../logger.js'
import type { MessageResponse, HandleMessageOptions } from './handler.js'

const log = rootLogger.child({ module: 'handler/router' })

const ALPHA_ENABLED = process.env.ALPHA_HANDLER_ENABLED === 'true'

if (ALPHA_ENABLED) {
    log.info('Handler: using Alpha pipeline (ALPHA_HANDLER_ENABLED=true)')
} else {
    log.info('Handler: using legacy pipeline (ALPHA_HANDLER_ENABLED=false)')
}

/**
 * Route a message to the correct handler based on the feature flag.
 * Drop-in compatible with the existing handleMessage signature.
 */
export async function handleMessage(
    channel: string,
    channelUserId: string,
    rawMessage: string,
    options: HandleMessageOptions = {},
): Promise<MessageResponse> {
    if (ALPHA_ENABLED) {
        const { handleMessageAlpha } = await import('./handler-alpha.js')
        return handleMessageAlpha(channel, channelUserId, rawMessage, options)
    }

    const { handleMessage: legacyHandle } = await import('./handler-legacy.js')
    return legacyHandle(channel, channelUserId, rawMessage, options)
}

export type { MessageResponse, HandleMessageOptions }
