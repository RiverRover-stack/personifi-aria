/**
 * Fusion Engine — Reactive Mode (#119)
 *
 * Per-message reactive decision pipeline:
 * 1. Check proactive_state table for active stimuli
 * 2. Detect direction mismatch → invalidate stale ProactiveState entries
 * 3. Check tool_results for pre-fetched data
 * 4. Route: respond / inject_prefetch / execute_tool
 * 5. Write signal packet for Sentinel consumption
 */

import type { Pool } from 'pg'
import type { EngagementState } from '../pulse/types.js'
import type { ReactiveInput, ReactiveOutput, PreferencesMap, SignalPacketInput } from './types.js'
import type { ProactiveStateRow } from '../db/fusion-tables.js'
import {
    getActiveProactiveState,
    claimToolResult,
    invalidateProactiveStimuli,
    insertSignalPacket,
} from '../db/fusion-tables.js'
import { getFusionMode } from './mode-switch.js'
import { logger as rootLogger } from '../logger.js'

const log = rootLogger.child({ module: 'fusion/reactive' })

/**
 * Make a reactive routing decision for an incoming message.
 *
 * Checks proactive_state, detects direction mismatches to invalidate
 * stale context, and routes to the appropriate action.
 */
export async function fusionReactiveDecision(
    pool: Pool,
    input: ReactiveInput,
): Promise<ReactiveOutput> {
    const { userId, userMessage, extractedSignals, toolRequest, contextBundle, pulseState } = input

    // 1. Check for active proactive stimuli
    const activeStimuli = await getActiveProactiveState(pool, userId)

    // 2. Detect direction mismatch — invalidate stale stimuli
    const invalidated = detectDirectionMismatch(activeStimuli, extractedSignals, userMessage)
    if (invalidated.length > 0) {
        await invalidateProactiveStimuli(pool, userId, invalidated)
    }

    // Filter out invalidated stimuli from active set
    const validStimuli = activeStimuli.filter(s => !invalidated.includes(s.stimulus_key))

    // No valid stimuli — standard respond
    if (validStimuli.length === 0) {
        const signal = buildSignalPacket(userId, invalidated, extractedSignals, userMessage)
        writeSignalPacket(pool, signal)

        return {
            decision: 'respond',
            toolResult: null,
            contextAdditions: [],
            pulseDelta: 0,
            proactiveContext: null,
            invalidatedStimuli: invalidated,
            confidence: 1.0,
        }
    }

    // 3. Check if the top stimulus has a pre-fetched tool result
    const topStimulus = validStimuli[0]
    let prefetchedResult = null

    if (topStimulus.result_ref) {
        const [toolName, argsHash] = topStimulus.result_ref.split(':')
        if (toolName && argsHash) {
            prefetchedResult = await claimToolResult(pool, userId, toolName, argsHash)
        }
    }

    // Build natural-language context additions from valid stimuli.
    // These are injected into Alpha's system prompt when a user message arrives
    // while a proactive stimulus is buffered or delivered but not yet addressed.
    //
    // IMPORTANT: These must be natural-language INSTRUCTIONS, not raw JSON dumps.
    // Alpha (Llama 70B) needs to know WHAT to do with the context, not just see data.
    const contextAdditions = validStimuli.map(s => {
        const d = s.data
        const parts: string[] = [
            `[ARIA — Proactive context active (${s.stimulus_type})]`,
        ]

        // If Sentinel already sent a proactive message, tell Alpha what was said
        const prevMsg = d._proactive_message as string | undefined
        if (prevMsg) {
            parts.push(`You already sent this message to the user: "${prevMsg}"`)
            parts.push(`If the user is responding to it, continue that thread naturally.`)
        } else {
            // Buffered (not yet sent) — weave it in naturally when appropriate
            if (d.message)          parts.push(`Background context: ${d.message}`)
            if (d.suggestedAction)  parts.push(`Potential action: ${d.suggestedAction}`)
            if (d.overlappingTopic) parts.push(`Your squad is talking about: ${d.overlappingTopic}`)
            if (d.scheduled_for)    parts.push(`Upcoming: ${d.description ?? 'an event'} on ${d.scheduled_for}`)
            if (d.eventName)        parts.push(`Event nearby: ${d.eventName}`)
            if (d.menuItems)        parts.push(`Meal context: ${String(d.menuItems).slice(0, 150)}`)
            parts.push(`Priority score: ${s.score?.toFixed(2) ?? '?'} — weave this into your response naturally if it relates to what the user is saying. If unrelated, note it for later.`)
        }

        return parts.filter(Boolean).join('\n')
    })

    // 4. Route based on what we found
    const signal = buildSignalPacket(userId, invalidated, extractedSignals, userMessage)
    writeSignalPacket(pool, signal)

    if (prefetchedResult) {
        return {
            decision: 'inject_prefetch',
            toolResult: prefetchedResult,
            contextAdditions,
            pulseDelta: 0,
            proactiveContext: validStimuli,
            invalidatedStimuli: invalidated,
            confidence: computeReactiveConfidence(pulseState, validStimuli.length),
        }
    }

    // Stimuli exist but no cached result — could trigger tool execution
    const { threshold } = getFusionMode(pulseState)
    log.debug({ threshold, topScore: topStimulus.score, pulseState }, 'Fusion reactive threshold')
    if (topStimulus.score >= threshold && (pulseState === 'PROACTIVE' || pulseState === 'ENGAGED')) {
        return {
            decision: 'execute_tool',
            toolResult: null,
            contextAdditions,
            pulseDelta: 0,
            proactiveContext: validStimuli,
            invalidatedStimuli: invalidated,
            confidence: computeReactiveConfidence(pulseState, validStimuli.length),
        }
    }

    // Default: respond with stimuli as additional context
    return {
        decision: 'respond',
        toolResult: null,
        contextAdditions,
        pulseDelta: 0,
        proactiveContext: validStimuli,
        invalidatedStimuli: invalidated,
        confidence: computeReactiveConfidence(pulseState, validStimuli.length),
    }
}

// ─── Direction Mismatch Detection ───────────────────────────────────────────

/**
 * Detect when the user's current direction doesn't match active stimuli.
 * Returns stimulus_keys that should be invalidated (marked stale).
 *
 * Example: Sentinel buffered "comedy show" but user is now asking about food.
 * The comedy show stimulus is stale and should not be injected.
 */
function detectDirectionMismatch(
    activeStimuli: ProactiveStateRow[],
    signals: ReactiveInput['extractedSignals'],
    userMessage: string,
): string[] {
    if (activeStimuli.length === 0) return []
    if (!signals.topic && !signals.intent) return [] // no signal to compare against

    const stale: string[] = []
    const userDirection = (signals.topic || signals.intent || '').toLowerCase()
    const messageLower = userMessage.toLowerCase()

    for (const stimulus of activeStimuli) {
        const stimType = stimulus.stimulus_type.toLowerCase()
        const stimKey = stimulus.stimulus_key.toLowerCase()
        const stimData = JSON.stringify(stimulus.data).toLowerCase()

        // Check if user's direction has any overlap with the stimulus
        const hasOverlap =
            stimType.includes(userDirection) ||
            userDirection.includes(stimType) ||
            stimKey.includes(userDirection) ||
            stimData.includes(userDirection) ||
            messageLower.includes(stimType)

        if (!hasOverlap && userDirection.length > 0) {
            stale.push(stimulus.stimulus_key)
        }
    }

    return stale
}

// ─── Signal Packet Writing ──────────────────────────────────────────────────

/**
 * Extract a topic keyword from the raw message text when the classifier
 * returns null for both topic and intent (happens for "simple" messages like
 * "I'm craving biryani da"). Without this, signal_packets.current_direction
 * is null and collectSocialMonitor() can never detect squad convergence.
 *
 * Strategy: find the first content word (> 4 chars, not a stop word) that
 * appears in a known food/activity/place vocabulary, or fall back to the
 * longest word in the message.
 */
const TOPIC_STOP_WORDS = new Set([
    'about', 'after', 'again', 'also', 'been', 'before', 'being', 'could',
    'doing', 'going', 'have', 'just', 'know', 'like', 'little', 'make',
    'more', 'much', 'need', 'only', 'other', 'over', 'really', 'should',
    'some', 'than', 'that', 'their', 'them', 'then', 'there', 'these',
    'they', 'think', 'this', 'time', 'very', 'want', 'well', 'were',
    'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would',
    'your', 'yaar', 'bhai', 'dude', 'guys', 'lets', 'come', 'okay',
])

function extractTopicFromMessage(message: string): string | null {
    const words = message
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 4 && !TOPIC_STOP_WORDS.has(w))

    if (words.length === 0) return null
    // Return the longest meaningful word — tends to be the most specific noun
    return words.reduce((a, b) => (a.length >= b.length ? a : b))
}

function buildSignalPacket(
    userId: string,
    invalidated: string[],
    signals: ReactiveInput['extractedSignals'],
    userMessage: string,
): SignalPacketInput {
    // Use classifier topic/intent first; fall back to keyword extraction from
    // the raw message so simple messages ("craving biryani") still produce a
    // non-null current_direction for squad convergence detection.
    const currentDirection =
        signals.topic ||
        signals.intent ||
        extractTopicFromMessage(userMessage) ||
        null

    return {
        userId,
        invalidatedStimuli: invalidated,
        currentDirection,
        extractedIntents: signals.entities,
        engagementSignal: signals.sentiment,
    }
}

/** Fire-and-forget signal packet write for Sentinel consumption */
function writeSignalPacket(pool: Pool, signal: SignalPacketInput): void {
    insertSignalPacket(pool, {
        user_id: signal.userId,
        invalidated_stimuli: signal.invalidatedStimuli.length > 0 ? signal.invalidatedStimuli : null,
        current_direction: signal.currentDirection,
        extracted_intents: signal.extractedIntents.length > 0 ? signal.extractedIntents : null,
        engagement_signal: signal.engagementSignal,
    }).catch(err => console.error('[Fusion/Reactive] signal packet write failed:', (err as Error).message))
}

// ─── Confidence Computation ─────────────────────────────────────────────────

function computeReactiveConfidence(pulseState: EngagementState, stimulusCount: number): number {
    const stateBoost: Record<EngagementState, number> = {
        PROACTIVE: 0.3,
        ENGAGED: 0.2,
        CURIOUS: 0.1,
        PASSIVE: 0.0,
    }
    const base = 0.5
    const boost = stateBoost[pulseState] ?? 0.0
    const countBoost = Math.min(stimulusCount * 0.05, 0.2)
    return Math.min(base + boost + countBoost, 1.0)
}
