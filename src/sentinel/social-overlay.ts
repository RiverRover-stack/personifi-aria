/**
 * Sentinel Social Overlay — Phase 4 (#121)
 *
 * Applies a squad-convergence score boost to stimuli.
 * If 3+ friends are interested in the same topic → ×1.3 boost.
 * If an active squad discussion is happening → additional +0.10 boost.
 *
 * Currently a stub — social boost will be wired once the squad graph
 * exposes a per-user convergence query.
 */

import type { ScoredStimulus } from './types.js'

/**
 * Apply social overlay to a scored stimulus.
 * Returns the same stimulus with compositeScore multiplied by the boost.
 */
export async function applySocialOverlay(stimulus: ScoredStimulus): Promise<ScoredStimulus> {
    // TODO: query squads for topic convergence
    //   const boost = await getSquadConvergenceBoost(stimulus.userId, stimulus.stimulus.type)
    //   if (boost > 1.0) return { ...stimulus, compositeScore: Math.min(stimulus.compositeScore * boost, 1.0), socialBoost: boost }
    return { ...stimulus, socialBoost: 1.0 }
}
