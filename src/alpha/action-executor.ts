/**
 * Action Executor — runs multiple tools in parallel after user confirms checklist.
 * Sends results as separate burst messages with typing indicators.
 */

import { executeAlphaTool } from '../tool-executor.js'
import { pulseService } from '../pulse/index.js'
import { logger } from '../logger.js'

const log = logger.child({ module: 'alpha/action-executor' })

type EngagementState = 'PASSIVE' | 'CURIOUS' | 'ENGAGED' | 'PROACTIVE'
type PreferencesMap = Record<string, string>

interface PendingAction {
    toolName: string
    toolParams: Record<string, unknown>
}

interface ExecutionContext {
    preferences: PreferencesMap
    pulseState: EngagementState
}

async function sendTypingAction(chatId: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    }).catch(() => {})
}

async function sendMessage(chatId: string, text: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
    }).catch(() => {})
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Enrich tool params with user context (location, currency, etc.)
 */
function enrichParams(
    params: Record<string, unknown>,
    preferences: PreferencesMap,
): Record<string, unknown> {
    const enriched = { ...params }
    if (!enriched.location && preferences.home_location) {
        enriched.location = preferences.home_location
    }
    if (!enriched.currency && preferences.preferred_currency) {
        enriched.currency = preferences.preferred_currency
    }
    return enriched
}

/**
 * Execute all checklist actions in parallel and send results as burst messages.
 */
export async function executeActionChecklist(
    userId: string,
    chatId: string,
    pendingActions: PendingAction[],
    context: ExecutionContext,
): Promise<void> {
    if (pendingActions.length === 0) return

    // Send "on it" message immediately
    await sendTypingAction(chatId)
    await sleep(400)
    await sendMessage(chatId, `On it! Running ${pendingActions.length} task${pendingActions.length !== 1 ? 's' : ''} for you...`)

    // Enrich params and run all tools in parallel
    const enrichedActions = pendingActions.map(a => ({
        ...a,
        toolParams: enrichParams(a.toolParams, context.preferences),
    }))

    const results = await Promise.allSettled(
        enrichedActions.map(a => executeAlphaTool(a.toolName, JSON.stringify(a.toolParams), userId)),
    )

    // Send each result as a separate message with typing indicator
    for (let i = 0; i < results.length; i++) {
        const result = results[i]
        const action = enrichedActions[i]

        const typingDelay = 600
        await sendTypingAction(chatId)
        await sleep(typingDelay)

        if (result.status === 'fulfilled' && result.value.success && result.value.data) {
            const text = typeof result.value.data === 'string'
                ? result.value.data
                : JSON.stringify(result.value.data)
            await sendMessage(chatId, text.slice(0, 4096))
        } else {
            const reason = result.status === 'rejected'
                ? (result.reason as Error)?.message ?? 'unknown error'
                : (result.value as any)?.error ?? 'no data returned'
            await sendMessage(chatId, `Couldn't complete "${action.toolName}": ${reason}`)
            log.warn({ userId, toolName: action.toolName, reason }, 'Action executor tool failed')
        }
    }

    // Positive engagement signal
    pulseService.recordEngagement({
        userId,
        message: `[action_checklist: ${pendingActions.map(a => a.toolName).join(', ')}]`,
        previousUserMessage: null,
        previousMessageAt: null,
        classifierSignal: 'normal',
    }).catch(err => log.error({ err }, 'Pulse record failed after action checklist'))

    log.info({ userId, actionCount: pendingActions.length }, 'Action checklist executed')
}
