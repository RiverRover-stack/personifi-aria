/**
 * Action Mode Detector — decides whether to show an action checklist
 * instead of a prose response, based on pulse score + classification + context.
 */

import type { ChecklistItem } from '../proactive-intent/types.js'
import type { ProactiveStateRow } from '../db/fusion-tables.js'

export interface ActionModeDecision {
    shouldShowChecklist: boolean
    suggestedItems: ChecklistItem[]
    reason: string
}

// Minimal classification shape needed here
interface ClassificationResult {
    tool_hint?: string | null
    intent?: string | null
    message_complexity?: string
}

type EngagementState = 'PASSIVE' | 'CURIOUS' | 'ENGAGED' | 'PROACTIVE'
type PreferencesMap = Record<string, string>

// ─── Tool hint → checklist item mapping ──────────────────────────────────────

const TOOL_TO_CHECKLIST: Record<string, ChecklistItem> = {
    compare_rides: {
        id: 'compare_rides',
        label: '🚕 Compare Uber vs Rapido prices',
        toolName: 'compare_rides',
        toolParams: {},
    },
    compare_food_prices: {
        id: 'compare_food',
        label: '🍱 Compare food prices',
        toolName: 'compare_food_prices',
        toolParams: {},
    },
    search_blinkit: {
        id: 'grocery',
        label: '🛒 Check Blinkit for groceries',
        toolName: 'search_blinkit',
        toolParams: {},
    },
    search_flights: {
        id: 'flights',
        label: '✈️ Search flights',
        toolName: 'search_flights',
        toolParams: {},
    },
    search_hotels: {
        id: 'hotels',
        label: '🏨 Search hotels',
        toolName: 'search_hotels',
        toolParams: {},
    },
    compare_grocery_prices: {
        id: 'grocery',
        label: '🛒 Compare grocery prices',
        toolName: 'compare_grocery_prices',
        toolParams: {},
    },
}

// Stimulus type → checklist item mapping
const STIMULUS_TO_CHECKLIST: Record<string, ChecklistItem> = {
    traffic: {
        id: 'compare_rides',
        label: '🚕 Compare Uber vs Rapido prices',
        toolName: 'compare_rides',
        toolParams: {},
    },
    weather: {
        id: 'compare_food',
        label: '🍱 Compare food delivery options',
        toolName: 'compare_food_prices',
        toolParams: {},
    },
    food: {
        id: 'compare_food',
        label: '🍱 Compare food prices',
        toolName: 'compare_food_prices',
        toolParams: {},
    },
}

/**
 * Decide whether to show an action checklist for this turn.
 */
export function detectActionMode(
    pulseState: EngagementState,
    pulseScore: number,
    classification: ClassificationResult,
    activeProactiveContext: ProactiveStateRow[] | null,
    _preferences: PreferencesMap,
): ActionModeDecision {
    // Gate 1: pulse score too low
    if (pulseScore < 65) {
        return { shouldShowChecklist: false, suggestedItems: [], reason: 'pulse_too_low' }
    }

    // Gate 2: questions get answered, not checklisted
    const isQuestion = classification.intent === 'question' || classification.message_complexity === 'simple'
    if (isQuestion) {
        return { shouldShowChecklist: false, suggestedItems: [], reason: 'question_not_checklist' }
    }

    const items: ChecklistItem[] = []
    const seenIds = new Set<string>()

    // Source 1: tool hint from classifier
    const toolHint = classification.tool_hint
    if (toolHint && TOOL_TO_CHECKLIST[toolHint]) {
        const item = TOOL_TO_CHECKLIST[toolHint]
        if (!seenIds.has(item.id)) {
            items.push(item)
            seenIds.add(item.id)
        }
    }

    // Source 2: active proactive context (FIRE-scored stimuli)
    if (activeProactiveContext) {
        for (const stimulus of activeProactiveContext) {
            const item = STIMULUS_TO_CHECKLIST[stimulus.stimulus_type]
            if (item && !seenIds.has(item.id)) {
                items.push(item)
                seenIds.add(item.id)
            }
        }
    }

    if (items.length >= 2) {
        return { shouldShowChecklist: true, suggestedItems: items, reason: `pulse=${pulseScore} items=${items.length}` }
    }

    return { shouldShowChecklist: false, suggestedItems: items, reason: 'insufficient_items' }
}
