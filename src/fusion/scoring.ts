/**
 * Fusion Engine — Scoring Formula
 *
 * score = stimulus_weight x pref_match(user, stimulus) x receptivity(user) x (1 - fatigue(user))
 *
 * Components:
 *   stimulus_weight: base priority by type (0-1)
 *   pref_match: how well stimulus data matches user preferences (0-1)
 *   receptivity: derived from Pulse engagement state (0-1)
 *   fatigue: proactive_count_today / max_per_day, capped at 1.0
 */

import type { EngagementState } from '../pulse/types.js'
import type { StimulusInput, UserContext, PreferencesMap } from './types.js'
import { getFusionMode } from './mode-switch.js'

// ─── Stimulus Base Weights ──────────────────────────────────────────────────

const STIMULUS_WEIGHTS: Record<string, number> = {
    weather: 0.9,
    traffic: 0.85,
    social: 0.7,
    event: 0.6,
    food: 0.5,
    price: 0.4,
}

/** Get the base weight for a stimulus type. Defaults to 0.3 for unknown types. */
export function getStimulusWeight(type: string): number {
    return STIMULUS_WEIGHTS[type] ?? 0.3
}

// ─── Receptivity ────────────────────────────────────────────────────────────

const RECEPTIVITY: Record<EngagementState, number> = {
    PROACTIVE: 1.0,
    ENGAGED: 0.8,
    CURIOUS: 0.5,
    PASSIVE: 0.2,
}

export function getReceptivity(state: EngagementState): number {
    return RECEPTIVITY[state] ?? 0.2
}

// ─── Preference Matching ────────────────────────────────────────────────────

/**
 * Score how well a stimulus matches user preferences.
 * - Exact match on a preference key → 1.0
 * - Category-level match (stimulus type appears in prefs) → 0.7
 * - No match → 0.3
 */
export function prefMatch(preferences: PreferencesMap, stimulus: StimulusInput): number {
    if (!preferences || Object.keys(preferences).length === 0) return 0.3

    const stimulusType = stimulus.type.toLowerCase()
    const stimulusKey = stimulus.key.toLowerCase()
    const dataStr = JSON.stringify(stimulus.data).toLowerCase()

    for (const [category, value] of Object.entries(preferences)) {
        if (!value) continue
        const catLower = category.toLowerCase()
        const valLower = value.toLowerCase()

        // Exact key match: stimulus key contains a preference value
        if (stimulusKey.includes(valLower) || dataStr.includes(valLower)) {
            return 1.0
        }
        // Category match: stimulus type aligns with preference category
        if (catLower.includes(stimulusType) || stimulusType.includes(catLower)) {
            return 0.7
        }
    }

    return 0.3
}

// ─── Fatigue ────────────────────────────────────────────────────────────────

/**
 * Compute fatigue factor (0-1). Higher = more fatigued.
 * fatigue = proactive_count_today / max_per_day, capped at 1.0
 */
export function computeFatigue(proactiveCountToday: number, maxPerDay: number): number {
    if (maxPerDay <= 0) return 1.0
    return Math.min(proactiveCountToday / maxPerDay, 1.0)
}

// ─── Main Scoring Function ──────────────────────────────────────────────────

/**
 * Compute the fusion score for a stimulus given user context.
 * score = stimulus_weight x pref_match x receptivity x (1 - fatigue)
 */
export function computeFusionScore(stimulus: StimulusInput, userCtx: UserContext): number {
    const weight = stimulus.weight > 0 ? stimulus.weight : getStimulusWeight(stimulus.type)
    const match = prefMatch(userCtx.preferences, stimulus)
    const receptivity = getReceptivity(userCtx.pulseState)
    const mode = getFusionMode(userCtx.pulseState)
    const fatigue = computeFatigue(userCtx.proactiveCountToday, mode.maxProactivePerDay)

    return weight * match * receptivity * (1 - fatigue)
}
