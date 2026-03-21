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
        const signal = buildSignalPacket(userId, invalidated, extractedSignals)
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

    // Build context additions from valid stimuli
    const contextAdditions = validStimuli.map(s =>
        `[Proactive/${s.stimulus_type}] ${s.stimulus_key}: ${JSON.stringify(s.data)}`
    )

    // 4. Route based on what we found
    const signal = buildSignalPacket(userId, invalidated, extractedSignals)
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
    if (topStimulus.score >= 0.8 && (pulseState === 'PROACTIVE' || pulseState === 'ENGAGED')) {
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

function buildSignalPacket(
    userId: string,
    invalidated: string[],
    signals: ReactiveInput['extractedSignals'],
): SignalPacketInput {
    return {
        userId,
        invalidatedStimuli: invalidated,
        currentDirection: signals.topic || signals.intent,
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
