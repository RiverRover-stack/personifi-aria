/**
 * Alpha Proactive Caller — Sentinel-triggered message generation
 *
 * ARCHITECTURE:
 *   All messages to the user flow through Alpha (the LLM) so the voice, tone,
 *   and context are always consistent. Sentinel is the intelligence layer that
 *   DECIDES when and what to surface — Alpha is the mouth that SAYS it.
 *
 *   Sentinel collects stimuli → scores → FIRE decision → callAlphaProactive()
 *   → Alpha generates natural message (optionally calling an active tool)
 *   → Telegram delivery
 *
 * TOOL CLASSIFICATION:
 *
 *   Stimulus (passive) tools — Sentinel uses these to detect background conditions.
 *   They run in collectors, produce StimulusInput rows, never talk to user directly.
 *   Examples: get_weather, get_traffic, check_air_quality, monitor_prices
 *
 *   Active (execution) tools — Alpha calls these during conversation (reactive or proactive).
 *   Their output is formatted and sent to the user as part of a response.
 *   Examples: search_places, compare_food_prices, compare_rides, get_directions
 *
 * PROACTIVE vs REACTIVE in Alpha:
 *
 *   Reactive: user sends message → Alpha responds (may call active tools)
 *   Proactive: Sentinel FIRE → callAlphaProactive() → Alpha initiates (may call active tools)
 *
 *   The key difference is who initiates. In proactive mode Alpha's system prompt
 *   instructs it to reach out naturally, not wait for user commands.
 */

import { AlphaProvider } from '../providers/alpha-provider.js'
import { executeAlphaTool } from '../tool-executor.js'
import { loadPreferences } from '../memory.js'
import { getPool } from '../character/session-store.js'
import { filterOutput } from '../character/output-filter.js'
import { getRawSoulPrompt } from './alpha-prompt-builder.js'
import { logger } from '../logger.js'
import type { StimulusInput } from '../fusion/types.js'
import type { SentinelUserContext } from '../sentinel/types.js'

const log = logger.child({ module: 'alpha/proactive' })

// Singleton provider — reuses the Together → Fireworks → Groq chain
const alphaProvider = new AlphaProvider()

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProactiveAlphaResult {
    message: string
    toolCalled: boolean
    toolName?: string
}

// ─── Tool classification ──────────────────────────────────────────────────────

/**
 * Stimulus (passive) tools used by Sentinel collectors in the background.
 * These detect conditions — they are NOT directly called by Alpha.
 */
export const STIMULUS_TOOLS = new Set([
    'get_weather',
    'get_traffic',
    'check_air_quality',
    'check_pollen',
    'get_festival_data',
])

/**
 * Active (execution) tools called by Alpha during conversation (reactive or proactive).
 * These produce formatted results shown to the user.
 */
export const ACTIVE_TOOLS = new Set([
    'search_places',
    'compare_food_prices',
    'compare_grocery_prices',
    'compare_prices_proactive',
    'compare_rides',
    'get_directions',
    'get_hotels',
    'get_flights',
    'get_currency',
])

// ─── Stimulus → active tool mapping ──────────────────────────────────────────

/**
 * Maps stimulus types to the active tool Alpha should call when proactively firing.
 * Only runs when pulse is ENGAGED or PROACTIVE — otherwise message is text-only.
 */
interface ToolMapping {
    toolName: string
    buildParams: (
        data: Record<string, unknown>,
        prefs: Record<string, string>,
    ) => Record<string, unknown>
}

const STIMULUS_TO_ACTIVE_TOOL: Record<string, ToolMapping | null> = {
    // Food stimulus → compare live prices on Swiggy/Zomato
    food: {
        toolName: 'compare_food_prices',
        buildParams: (data, _prefs) => ({
            query: (data.suggestedAction as string) || 'popular food',
            location: (data.location as string) || '',
        }),
    },
    // Price stimulus → proactive price comparison
    price: {
        toolName: 'compare_prices_proactive',
        buildParams: (data) => ({
            query: (data.suggestedAction as string) || 'popular items',
            location: (data.location as string) || '',
        }),
    },
    // Local event → search for nearby venues / event details
    local_event: {
        toolName: 'search_places',
        buildParams: (data) => ({
            query: (data.eventName as string) || 'events near me',
            location: (data.location as string) || '',
        }),
    },
    // Social convergence, weather, traffic, plan reminders, topics, mess menu:
    // All have sufficient data in the payload — no additional tool call needed
    social:          null,
    weather:         null,
    traffic:         null,
    plan_reminder:   null,
    topic_followup:  null,
    mess_menu:       null,
    interest_intent: null,
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildHumanReadableStimulusContext(stimulus: StimulusInput): string {
    const d = stimulus.data
    const lines: string[] = [`Stimulus type: ${stimulus.type}`]

    if (d.message)         lines.push(`Context: ${d.message}`)
    if (d.suggestedAction) lines.push(`Suggested action: ${d.suggestedAction}`)
    if (d.description)     lines.push(`Details: ${d.description}`)
    if (d.scheduled_for)   lines.push(`Scheduled for: ${d.scheduled_for}`)
    if (d.location)        lines.push(`Location: ${d.location}`)
    if (d.overlappingTopic) lines.push(`Your squad is all talking about: ${d.overlappingTopic}`)
    if (d.memberCount)     lines.push(`Squad members interested: ${d.memberCount}`)
    if (d.menuItems)       lines.push(`Menu highlights: ${String(d.menuItems).slice(0, 200)}`)
    if (d.eventName)       lines.push(`Event: ${d.eventName}`)
    if (d.hashtag)         lines.push(`Hashtag: ${d.hashtag}`)

    return lines.join('\n')
}

function buildProactiveSystemPrompt(
    stimulus: StimulusInput,
    ctx: SentinelUserContext,
    userPrefs: Record<string, string>,
): string {
    const soulPrompt = getRawSoulPrompt()

    const prefsSummary = Object.entries(userPrefs)
        .slice(0, 8)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n')

    const stimulusContext = buildHumanReadableStimulusContext(stimulus)
    const userName = ctx.displayName ?? 'the user'

    return `${soulPrompt}

---
User: ${userName}
Preferences:
${prefsSummary || '  (none set yet)'}
Current engagement level: ${ctx.pulseState} (score=${ctx.pulseScore})

---
[PROACTIVE MESSAGE TASK]
You are reaching out to ${userName} based on something relevant happening right now.
This is YOU initiating — not waiting for them to ask. Think of it like a friend who
spotted something cool and sent a quick message.

What triggered this:
${stimulusContext}

Rules:
- Write ONE short, natural message in your casual Aria voice (1-3 sentences max)
- Be SPECIFIC — reference the actual detail (exact weather, event name, friend's topic, etc.)
- End with ONE concrete question or action offer that invites a reply
- Do NOT say generic things like "Hey! Something interesting is happening"
- Sound like a real friend, not a push notification
- If tool data is provided below, use actual figures/names from it (not generics)
- Do not explain what you're doing or why — just send the message
`
}

// ─── Main proactive Alpha entry point ────────────────────────────────────────

/**
 * Generate a proactive message in Alpha's voice for a Sentinel FIRE decision.
 *
 * Pipeline:
 *   1. Load user preferences for context
 *   2. Optionally call an active tool (food/price stimuli when pulse is ENGAGED+)
 *   3. Call Alpha with proactive system prompt + tool result
 *   4. Filter output
 *   5. Return message text
 *
 * Falls back to stimulus.data.message if Alpha generation fails.
 */
export async function callAlphaProactive(
    stimulus: StimulusInput,
    ctx: SentinelUserContext,
): Promise<ProactiveAlphaResult> {
    const pool = getPool()

    // ── 1. Load preferences ───────────────────────────────────────────────────
    let userPrefs: Record<string, string> = {}
    try {
        userPrefs = (await loadPreferences(pool, ctx.userId)) as Record<string, string>
    } catch {
        // preferences unavailable — proceed without
    }

    // ── 2. Optional active tool call (only for ENGAGED+ users) ───────────────
    let toolResultText: string | null = null
    let toolCalledName: string | undefined

    const toolMapping = STIMULUS_TO_ACTIVE_TOOL[stimulus.type] ?? null
    const isPulseHighEnough = ctx.pulseState === 'ENGAGED' || ctx.pulseState === 'PROACTIVE'

    if (toolMapping && isPulseHighEnough) {
        try {
            const toolParams = toolMapping.buildParams(stimulus.data, userPrefs)
            const execResult = await executeAlphaTool(
                toolMapping.toolName,
                JSON.stringify(toolParams),
                ctx.userId,
            )
            if (execResult.success && execResult.data != null) {
                toolResultText = typeof execResult.data === 'string'
                    ? execResult.data
                    : JSON.stringify(execResult.data)
                // Truncate to keep prompt budget sane (proactive messages should be short)
                if (toolResultText.length > 1200) {
                    toolResultText = toolResultText.slice(0, 1200) + '…'
                }
                toolCalledName = toolMapping.toolName
                log.info(
                    { userId: ctx.userId, tool: toolMapping.toolName },
                    'Proactive tool executed for Alpha',
                )
            }
        } catch (err) {
            log.warn(
                { userId: ctx.userId, tool: toolMapping?.toolName, err },
                'Proactive tool execution failed — proceeding without tool data',
            )
        }
    }

    // ── 3. Build context and call Alpha ───────────────────────────────────────
    const systemPrompt = buildProactiveSystemPrompt(stimulus, ctx, userPrefs)

    // Single user turn: either "use this tool data" or "generate from context"
    const userTurn = toolResultText
        ? `[Tool data]\n${toolResultText}\n\nUsing the above real data, write your proactive message to ${ctx.displayName ?? 'the user'} now.`
        : `Write your proactive message to ${ctx.displayName ?? 'the user'} now based on the stimulus context above.`

    const messages = [
        { role: 'user' as const, content: userTurn },
        // Sandwich defense
        {
            role: 'system' as const,
            content: 'Stay in character as Aria. Output ONLY the message text — no extra labels, no meta commentary.',
        },
    ]

    let messageText: string

    // Use alpha.chat() (not chatWithTools) — we've already executed any tool above,
    // so no function calling is needed here. chat() has the built-in Groq fallback:
    //   Together AI → Fireworks AI → Groq (via tierManager)
    // This means proactive message generation works with just a GROQ_API_KEY set.
    try {
        const response = await alphaProvider.chat({
            messages,
            systemPrompt,
            maxTokens: 180,     // proactive messages must be SHORT
            temperature: 0.88,  // slightly higher for natural personality
        })
        messageText = response.content?.trim() ?? ''
    } catch (err) {
        log.error(
            { userId: ctx.userId, err },
            'Alpha proactive generation failed on all providers — using stimulus message fallback',
        )
        // Last-resort fallback: use raw stimulus message field
        messageText = (stimulus.data.message as string) ||
            (stimulus.data.suggestedAction as string) ||
            'Hey! Something relevant just came up — want to check it out?'
    }

    // ── 4. Filter + validate ──────────────────────────────────────────────────
    if (messageText) {
        const filtered = filterOutput(messageText)
        messageText = filtered.filtered || messageText
    }

    if (!messageText) {
        messageText = (stimulus.data.message as string) ||
            'Hey! Something interesting is happening — ping me when you\'re free!'
    }

    log.info(
        {
            userId:    ctx.userId,
            stimulus:  stimulus.type,
            toolCalled: !!toolCalledName,
            msgLen:    messageText.length,
        },
        'Proactive Alpha generation complete',
    )

    return {
        message:    messageText,
        toolCalled: !!toolCalledName,
        toolName:   toolCalledName,
    }
}
