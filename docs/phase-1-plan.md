# Phase 1: Fusion Engine + Soul Files

## Issues Addressed

- **#119** — [Dev1] Create fusion-engine.ts: Dual-mode Fusion Engine
- **#120** — [Dev1] Create soul.md + sentinel-soul.md: Simplified personality files

## What was built

### 1. Fusion Engine (`src/fusion/`)

The central nervous system that evaluates stimuli and makes routing decisions.

**Files:**
- `types.ts` — All types matching #119 spec: `ReactiveInput`/`ReactiveOutput` (with `pulseDelta`, `extractedSignals`, `contextBundle`), `ProactiveDecision`, `StimulusInput`, `UserContext`, `FusionMode`, `PushbackDecision`, `RecoveryCheck`, `SignalPacketInput`
- `scoring.ts` — Scoring formula: `score = stimulus_weight x pref_match x receptivity x (1 - fatigue)`
- `reactive.ts` — Reactive mode: check proactive_state, detect direction mismatch (invalidate stale stimuli), route decision, write signal packets for Sentinel
- `proactive.ts` — Proactive mode: FIRE/BUFFER/DROP with full pushback protocol integration and recovery mode
- `pushback.ts` — Pushback protocol: 1st reject → RETRY_PIVOT (Pulse -18, try different angle), 2nd reject → BACK_OFF (Pulse -18, switch to REACTIVE mode). Recovery: 3 positive interactions in ENGAGED → re-enable PROACTIVE at threshold 0.85
- `mode-switch.ts` — Pulse-based mode switching with dynamic thresholds
- `index.ts` — Public API exports
- `fusion-engine.test.ts` — 37 Vitest unit tests covering scoring, mode switching, pushback protocol, recovery protocol, and proactive decisions

**From #119 — all acceptance criteria addressed:**
- [x] Reactive mode routes correctly (execute_tool / inject_prefetch / respond)
- [x] Proactive mode applies FIRE / BUFFER / DROP
- [x] Pulse-driven threshold adjustment works
- [x] Pushback protocol: retry once with different angle, back off on 2nd (Pulse -18 each)
- [x] Signal packet invalidation marks stale entries on direction mismatch
- [x] Unit tests for threshold boundary conditions

### 2. Soul Files (`config/`)

- `soul-v2.md` — Compact ~500 token socially-aware Aria personality. Sections: Identity (socially intelligent agent), Voice, Social Awareness (friend signals, weather, trending spots, ProactiveState integration), Response Rules, Emotional Mode
- `sentinel-soul.md` — ~300 token Sentinel scoring rules: formula, thresholds, social cascade (3+ friends → 1.3x boost), fatigue, pushback protocol, invalidation rules

**From #120 — all acceptance criteria addressed:**
- [x] soul-v2.md is under 500 tokens
- [x] sentinel-soul.md is under 300 tokens
- [x] Social awareness framing (friends, squad, trending, ProactiveState)
- [x] No personality layers, mood modes, or influence directives in soul-v2

### 3. Handler Integration

- `handler.ts` — Parallel Fusion Engine call at Step 7 with proper `ReactiveInput` construction from classifier fields (`detected_topic`, `tool_hint`, `interest_signal`)
- Feature flag: `FUSION_ENGINE_ENABLED` (default: false)

### 4. Personality Integration

- `personality.ts` — `loadSoulV2()` function loads soul-v2.md as Layer 1 alternative
- Feature flag: `SOUL_V2_ENABLED` (default: false)

## What was NOT changed (Phase 1 scope = additive)

- Existing handler pipeline behavior (zero regressions)
- personality.ts default behavior (SOUL.md still loads when flag is off)
- No tool calling changes (Phase 2A)
- No Sentinel loop (Phase 4)
- No killing of personality.ts / influence-engine / mood-engine (Phase 6)

## Feature Flags

| Flag | Default | Effect |
|------|---------|--------|
| `FUSION_ENGINE_ENABLED` | `false` | Enables parallel Fusion Engine logging in handler |
| `SOUL_V2_ENABLED` | `false` | Uses soul-v2.md as Layer 1 instead of SOUL.md |

## Scoring Formula

```
score = stimulus_weight x pref_match(user, stimulus) x receptivity(user) x (1 - fatigue(user))
```

| Component | Values |
|-----------|--------|
| stimulus_weight | weather=0.9, traffic=0.85, social=0.7, event=0.6, food=0.5, price=0.4 |
| pref_match | exact=1.0, category=0.7, none=0.3 |
| receptivity | PROACTIVE=1.0, ENGAGED=0.8, CURIOUS=0.5, PASSIVE=0.2 |
| fatigue | proactive_count_today / max_per_day (capped at 1.0) |

## Mode Switching Thresholds

| Pulse State | Threshold | Max/Day |
|-------------|-----------|---------|
| PROACTIVE   | 0.7       | 5       |
| ENGAGED     | 0.8       | 4       |
| CURIOUS     | 0.85      | 2       |
| PASSIVE     | 0.9       | 1       |

## Pushback Protocol

| Rejection # | Action | Pulse Delta | Behavior |
|-------------|--------|-------------|----------|
| 1st | RETRY_PIVOT | -18 | Retry with different angle/framing, raised threshold (+0.1) |
| 2nd+ | BACK_OFF | -18 | Switch to REACTIVE-only mode, only BUFFER (never FIRE) |
| Recovery | RE-ENABLE | 0 | 3 positive interactions in ENGAGED → PROACTIVE at threshold 0.85 |
