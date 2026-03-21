/**
 * Fusion Engine — Main Export (#119)
 *
 * Central nervous system for the dual-model fusion architecture.
 * Reactive mode: per-message stimulus check + direction mismatch + route decision
 * Proactive mode: stimulus scoring + FIRE/BUFFER/DROP + pushback protocol
 */

export { fusionReactiveDecision } from './reactive.js'
export { fusionProactiveDecision } from './proactive.js'
export { computeFusionScore, getStimulusWeight, getReceptivity, prefMatch, computeFatigue } from './scoring.js'
export { getFusionMode } from './mode-switch.js'
export { evaluatePushback, checkRecovery, PUSHBACK_PULSE_DELTA } from './pushback.js'
export type {
    ReactiveInput,
    ReactiveOutput,
    ReactiveRoute,
    ProactiveDecision,
    ProactiveAction,
    StimulusInput,
    UserContext,
    PreferencesMap,
    FusionMode,
    FusionModeLabel,
    PushbackDecision,
    PushbackAction,
    SignalPacketInput,
    RecoveryCheck,
} from './types.js'
