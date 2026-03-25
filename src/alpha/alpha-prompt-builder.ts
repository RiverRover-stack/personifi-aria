/**
 * Alpha Prompt Builder — Fusion Architecture (Unit 10)
 *
 * Drop-in replacement for personality.ts's composeSystemPrompt().
 * Targets ~500 tokens (vs 2000+ in the legacy 13-layer builder).
 *
 * Strategy:
 *   - soul-v2.md as base identity (hot-reloaded, ~400 tokens)
 *   - User context block: name + location + auth + pulse state
 *   - Tool-result injection (when present)
 *   - Active goal + top memory hint (when available)
 *   - Skip heavy layers (influence engine, mood-engine weights, graph fmt)
 */

import * as fs from 'fs'
import * as path from 'path'
import type { CognitiveState } from '../types/cognitive.js'
import type { MemoryItem } from '../memory-store.js'
import type { GraphSearchResult } from '../graph-memory.js'
import type { PreferencesMap } from '../types/database.js'
import type { ConversationGoalRecord } from '../types/cognitive.js'
import type { AgendaGoal } from '../agenda-planner/types.js'
import type { TopicIntent } from '../topic-intent/types.js'
import { logger as rootLogger } from '../logger.js'

const log = rootLogger.child({ module: 'alpha/prompt-builder' })

// ─── ComposeOptions (canonical definition — personality.ts deleted in Unit 10) ─

export interface ComposeOptions {
    /** User's latest message */
    userMessage: string
    /** Whether user has completed authentication */
    isAuthenticated: boolean
    /** User's display name (if known) */
    displayName?: string
    /** User's home location (if known) */
    homeLocation?: string
    /** Whether this is the user's first message */
    isFirstMessage?: boolean
    /** If true, only emit soul + compact user context (~300 tokens). */
    isSimpleMessage?: boolean
    /** Retrieved vector memories */
    memories?: MemoryItem[]
    /** Graph traversal results */
    graphContext?: GraphSearchResult[]
    /** Cognitive analysis results */
    cognitiveState?: CognitiveState
    /** User preferences from user_preferences table */
    preferences?: Partial<PreferencesMap>
    /** Active classifier goal from conversation_goals table */
    activeGoal?: ConversationGoalRecord | null
    /** Agenda planner stack (top goals) */
    agendaStack?: AgendaGoal[]
    /** Communication style signal */
    userSignal?: 'dry' | 'stressed' | 'roasting' | 'normal'
    /** True when a tool ran this turn */
    toolInvolved?: boolean
    /** Current Pulse engagement state */
    pulseEngagementState?: 'PASSIVE' | 'CURIOUS' | 'ENGAGED' | 'PROACTIVE'
    /** Tool that ran this turn (for influence strategy) */
    activeToolName?: string
    /** Active topics from topic_intents table */
    activeTopics?: TopicIntent[]
    /** Pre-computed topic strategy string */
    topicStrategy?: string | null
    /** Tool results (if any) */
    toolResults?: string
}

// ─── soul-v2.md Hot-Reload Cache ──────────────────────────────────────────────

let soulCache: string | null = null
let soulMtime = 0

function loadSoul(): string {
    const candidates = [
        path.resolve(process.cwd(), 'config', 'soul-v2.md'),
        path.resolve(process.cwd(), 'config', 'SOUL.md'),
    ]

    for (const soulPath of candidates) {
        try {
            const stat = fs.statSync(soulPath)
            const mtime = stat.mtimeMs
            if (soulCache && mtime === soulMtime) return soulCache

            soulCache = fs.readFileSync(soulPath, 'utf8')
            soulMtime = mtime
            log.debug({ path: soulPath }, 'soul file hot-reloaded')
            return soulCache
        } catch {
            // try next candidate
        }
    }

    log.warn('soul-v2.md and SOUL.md both missing — using minimal inline persona')
    return 'You are Aria, a friendly and knowledgeable AI travel guide for India. Text like a friend, never a bot.'
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a lean (~500-token) system prompt for the 70B response model.
 *
 * Accepts the same ComposeOptions as the legacy personality.ts so all
 * handler.ts call sites require zero changes beyond the import path.
 */
export function composeSystemPrompt(opts: ComposeOptions): string {
    const soul = loadSoul()
    const sections: string[] = [soul]

    // ── User context block ────────────────────────────────────────────────────
    const userLines: string[] = []
    if (opts.displayName)   userLines.push(`User's name: ${opts.displayName}`)
    if (opts.homeLocation)  userLines.push(`Home city: ${opts.homeLocation}`)
    if (!opts.isAuthenticated) userLines.push('User is not yet authenticated — guide through name + location setup if needed.')

    if (opts.pulseEngagementState && opts.pulseEngagementState !== 'PASSIVE') {
        userLines.push(`Engagement state: ${opts.pulseEngagementState} — lean into the energy, be more proactive.`)
    }
    if (opts.userSignal === 'stressed') {
        userLines.push('Mood signal: user sounds stressed. Drop wit; be calm and warm.')
    } else if (opts.userSignal === 'roasting') {
        userLines.push('Mood signal: playful roast session. Match the energy, keep it fun.')
    }

    if (userLines.length > 0) {
        sections.push(`## Runtime Context\n${userLines.join('\n')}`)
    }

    // Simple messages: stop here — soul + context only (~400 tokens)
    if (opts.isSimpleMessage) return sections.join('\n\n')

    // ── Active goal hint ──────────────────────────────────────────────────────
    if (opts.activeGoal?.goal) {
        sections.push(`## Conversation Goal\n${opts.activeGoal.goal}`)
    }

    // ── Top memory hint (max 3 bullets) ───────────────────────────────────────
    if (opts.memories && opts.memories.length > 0) {
        const bullets = opts.memories
            .slice(0, 3)
            .map(m => `- ${(m as any).memory ?? (m as any).text ?? (m as any).content ?? ''}`)
            .filter(Boolean)
            .join('\n')
        if (bullets) sections.push(`## About This User\n${bullets}`)
    }

    // ── Topic strategy ────────────────────────────────────────────────────────
    if (opts.topicStrategy) {
        sections.push(`## Conversation Strategy\n${opts.topicStrategy}`)
    }

    // ── Tool results ──────────────────────────────────────────────────────────
    if (opts.toolResults) {
        sections.push(`## Tool Results\n${opts.toolResults}`)
    }

    return sections.join('\n\n')
}

/**
 * Fallback: return raw soul content (used on composition error).
 * Matches personality.ts's getRawSoulPrompt() contract.
 */
export function getRawSoulPrompt(): string {
    return loadSoul()
}
