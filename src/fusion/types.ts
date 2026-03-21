/**
 * Fusion Engine Types — Phase 1 (#119, #120)
 *
 * Central type definitions for the dual-model fusion architecture.
 * Reactive mode: per-message stimulus check → route decision
 * Proactive mode: stimulus scoring → FIRE/BUFFER/DROP
 *
 * Types align with issue #119 ReactiveInput/ReactiveOutput spec.
 */

import type { EngagementState } from '../pulse/types.js'
import type { ProactiveStateRow, ToolResultRow } from '../db/fusion-tables.js'

// ─── Reactive Mode ──────────────────────────────────────────────────────────

export type ReactiveRoute = 'respond' | 'inject_prefetch' | 'execute_tool'

/** Input to reactive mode — matches #119 ReactiveInput spec */
export interface ReactiveInput {
    userId: string
    userMessage: string
    /** Signals extracted from the user message (from classifier or future Alpha NLU) */
    extractedSignals: {
        topic: string | null
        intent: string | null
        sentiment: 'positive' | 'negative' | 'neutral'
        entities: string[]
    }
    /** Tool request from the routing layer, if any */
    toolRequest: { name: string; args: Record<string, unknown> } | null
    /** Context bundle gathered in Step 6 */
    contextBundle: {
        memories: unknown[]
        preferences: PreferencesMap
        graphNeighbors: unknown[]
    }
    pulseState: EngagementState
    pulseScore: number
}

/** Output from reactive mode — matches #119 ReactiveOutput spec */
export interface ReactiveOutput {
    /** Routing decision */
    decision: ReactiveRoute
    /** Pre-fetched tool result if available */
    toolResult: ToolResultRow | null
    /** Proactive context strings to add to the LLM prompt */
    contextAdditions: string[]
    /** Suggested Pulse score delta from this decision */
    pulseDelta: number
    /** Active proactive stimuli found (for logging/debugging) */
    proactiveContext: ProactiveStateRow[] | null
    /** Stimulus keys that should be invalidated (direction mismatch) */
    invalidatedStimuli: string[]
    /** Confidence in this routing decision (0-1) */
    confidence: number
}

// ─── Proactive Mode ─────────────────────────────────────────────────────────

export type ProactiveAction = 'FIRE' | 'BUFFER' | 'DROP'

export interface ProactiveDecision {
    /** Whether to fire, buffer, or drop this stimulus */
    action: ProactiveAction
    /** Computed score (0-1) */
    score: number
    /** Human-readable reason for the decision */
    reason: string
    /** The stimulus that was evaluated */
    stimulus: StimulusInput
    /** Suggested Pulse delta if this decision is acted on */
    pulseDelta: number
}

// ─── Scoring ────────────────────────────────────────────────────────────────

export interface StimulusInput {
    /** Stimulus category (weather, traffic, food, social, event, price) */
    type: string
    /** Unique key for deduplication */
    key: string
    /** Base weight for this stimulus type (0-1) */
    weight: number
    /** Arbitrary payload from the stimulus source */
    data: Record<string, unknown>
}

export interface UserContext {
    userId: string
    pulseState: EngagementState
    pulseScore: number
    preferences: PreferencesMap
    /** Number of recent rejections from pushback_tracker */
    recentPushbacks: number
    /** How many proactive messages sent today (fatigue check) */
    proactiveCountToday: number
    /** Consecutive positive interactions (for recovery protocol) */
    positiveInteractionStreak: number
    /** Whether user is currently in REACTIVE-only mode (after 2nd pushback) */
    reactiveOnly: boolean
}

export type PreferencesMap = Partial<Record<string, string>>

// ─── Mode Switching ─────────────────────────────────────────────────────────

export type FusionModeLabel = 'PROACTIVE' | 'ENGAGED' | 'CURIOUS' | 'PASSIVE'

export interface FusionMode {
    /** Current mode derived from Pulse state */
    mode: FusionModeLabel
    /** Score threshold for FIRE (lower = more aggressive) */
    threshold: number
    /** Maximum proactive messages per day */
    maxProactivePerDay: number
}

// ─── Pushback Protocol ──────────────────────────────────────────────────────

export type PushbackAction = 'RETRY_PIVOT' | 'BACK_OFF' | 'ALLOW'

export interface PushbackDecision {
    action: PushbackAction
    /** Suggested Pulse delta from this pushback (-18 per rejection) */
    pulseDelta: number
    reason: string
}

// ─── Signal Packet (Alpha → Sentinel bridge) ────────────────────────────────

export interface SignalPacketInput {
    userId: string
    /** Stimulus keys that are no longer relevant (user pivoted) */
    invalidatedStimuli: string[]
    /** Current user direction/topic detected this turn */
    currentDirection: string | null
    /** New intents extracted for Sentinel's next scoring pass */
    extractedIntents: string[]
    /** Engagement signal from this interaction */
    engagementSignal: 'positive' | 'negative' | 'neutral'
}

// ─── Recovery Protocol ──────────────────────────────────────────────────────

export interface RecoveryCheck {
    /** Whether PROACTIVE mode should be re-enabled */
    shouldRecover: boolean
    /** The threshold to use after recovery (0.85 = softer) */
    recoveryThreshold: number
    reason: string
}
