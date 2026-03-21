/**
 * Fusion Engine — Mode Switching
 *
 * Maps Pulse engagement state → Fusion mode with dynamic thresholds.
 *
 * PROACTIVE (score 80-100): threshold 0.7, max 5/day — aggressive
 * ENGAGED   (score 50-79):  threshold 0.8, max 4/day — balanced
 * CURIOUS   (score 25-49):  threshold 0.85, max 2/day — cautious
 * PASSIVE   (score 0-24):   threshold 0.9, max 1/day — minimal
 */

import type { EngagementState } from '../pulse/types.js'
import type { FusionMode, FusionModeLabel } from './types.js'

interface ModeConfig {
    mode: FusionModeLabel
    threshold: number
    maxProactivePerDay: number
}

const MODE_MAP: Record<EngagementState, ModeConfig> = {
    PROACTIVE: { mode: 'PROACTIVE', threshold: 0.7, maxProactivePerDay: 5 },
    ENGAGED:   { mode: 'ENGAGED',   threshold: 0.8, maxProactivePerDay: 4 },
    CURIOUS:   { mode: 'CURIOUS',   threshold: 0.85, maxProactivePerDay: 2 },
    PASSIVE:   { mode: 'PASSIVE',   threshold: 0.9, maxProactivePerDay: 1 },
}

/**
 * Get the Fusion mode configuration for a given Pulse state.
 */
export function getFusionMode(pulseState: EngagementState): FusionMode {
    return MODE_MAP[pulseState] ?? MODE_MAP.PASSIVE
}
