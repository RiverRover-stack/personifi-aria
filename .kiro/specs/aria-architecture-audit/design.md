# PERSONIFI-ARIA — Deep Architecture Compliance Report (Verified)

## Audit Basis
- Codebase root: `/Users/adityashandilya/Desktop/personifi-aria/`
- All claims verified against actual file contents and grep results.
- Previous report had 4 major errors — all corrected below.

---

## CORRECTIONS FROM PREVIOUS REPORT

| Previous Claim | Actual Truth |
|---|---|
| V-01: `startSentinel()` never called | WRONG — `scheduler.ts` line 58 calls `startSentinel()` after migrations. Sentinel IS running. |
| V-04: `personality.ts` still active, handler uses legacy builder | WRONG — `personality.ts` is DELETED. `handler.ts` line 46 imports from `../alpha/alpha-prompt-builder.js` |
| V-05/V-06: mood-engine and influence-engine injected via prompt builder | WRONG — `alpha-prompt-builder.ts` explicitly skips both. `computeMoodWeights`/`getMoodInstruction` are not called anywhere outside `mood-engine.ts` itself. |
| V-07: Duplicate cron execution when Sentinel starts | WRONG — `scheduler.ts` was fully refactored. All 12 old crons removed. Only heartbeat + media cron + Sentinel remain. |

---

## 1. ARCHITECTURE TREE

Legend: ✅ EXISTS | ⚠️ PARTIAL | ❌ MISSING | 🚫 VIOLATION

### ALPHA Layer

| Spec Component | Actual File | Status | Notes |
|---|---|---|---|
| alpha/alpha_router | `src/alpha/alpha-caller.ts` → `callAlpha()` | ✅ EXISTS | 1-or-2-call pipeline, Together→Fireworks→Groq |
| alpha/nlu_extractor | `src/cognitive.ts` → `classifyMessage()` | ⚠️ PARTIAL | Correct logic, wrong location — lives at root not in alpha/ |
| alpha/response_generator | `src/providers/alpha-provider.ts` + `src/llm/tierManager.ts` | ✅ EXISTS | AlphaProvider failover chain |
| alpha/tool_caller | `src/tool-executor.ts` → `executeAlphaTool()` | ✅ EXISTS | Sandbox + name mapping |
| alpha/signal_writer | Inline in `src/character/handler.ts` `setImmediate()` block | ⚠️ PARTIAL | Not a standalone module; signal packet write to Fusion gated behind `FUSION_ENGINE_ENABLED=false` |
| alpha/context_manager | `src/alpha/context-manager.ts` → `buildContext()` | ✅ EXISTS | 8192-token budget |
| alpha/prompt_builder | `src/alpha/alpha-prompt-builder.ts` → `composeSystemPrompt()` | ✅ EXISTS | Used by handler.ts (personality.ts deleted) |

### SENTINEL Layer

| Spec Component | Actual File | Status | Notes |
|---|---|---|---|
| sentinel/sentinel_loop | `src/sentinel/sentinel-loop.ts` → `sentinelTick()` | ✅ EXISTS + RUNNING | Started from `scheduler.ts` line 58 |
| sentinel/stimulus_scanner | `src/sentinel/collectors.ts` → `collectStimulusRefresh()` | ⚠️ PARTIAL | Weather/traffic/festival work; social/topic/content are stubs |
| sentinel/preference_extractor | `src/intelligence/intelligence-cron.ts` | ⚠️ PARTIAL | Logic exists but NOT wired into Sentinel collectors |
| sentinel/memory_processor | `src/sentinel/collectors.ts` → `runMemoryProcess()` | ✅ EXISTS | Delegates to archivist queue |
| sentinel/topic_followup | `src/sentinel/collectors.ts` → `collectTopicFollowup()` | ❌ MISSING | Stub — returns [] |
| sentinel/social_monitor | `src/sentinel/collectors.ts` → `collectSocialMonitor()` | ❌ MISSING | Stub — returns [] |
| sentinel/model | `src/llm/providers/sentinel-provider.ts` | 🚫 VIOLATION | Spec: Ollama Nemotron 70B/Qwen. Actual: AWS Bedrock (Claude Haiku) + Together AI |

### FUSION ENGINE

| Spec Component | Actual File | Status | Notes |
|---|---|---|---|
| fusion/fusion_router | `src/fusion/index.ts` | ✅ EXISTS | Exports both paths |
| fusion/mode_switcher | `src/fusion/mode-switch.ts` + `src/sentinel/mode-switch.ts` | ✅ EXISTS | Two-layer: Fusion maps pulse→threshold; Sentinel evaluates PROACTIVE↔REACTIVE |
| fusion/proactive_evaluator | `src/fusion/proactive.ts` → `fusionProactiveDecision()` | ✅ EXISTS | FIRE/BUFFER/DROP + pushback protocol |
| fusion/reactive_pipeline | `src/fusion/reactive.ts` → `fusionReactiveDecision()` | ⚠️ PARTIAL | Implemented but gated behind `FUSION_ENGINE_ENABLED=false` env var — logging only, does not affect behavior |
| fusion/scoring | `src/fusion/scoring.ts` → `computeFusionScore()` | ✅ EXISTS | Exact spec formula |
| fusion/pushback | `src/fusion/pushback.ts` | ✅ EXISTS | Full pushback + recovery protocol |

### PULSE + DATA Layer

| Spec Component | Actual File | Status | Notes |
|---|---|---|---|
| pulse/pulse_state_machine | `src/pulse/state-machine.ts` → `transitionState()` | ✅ EXISTS | Correct thresholds + hysteresis |
| pulse/pulse_update_engine | `src/pulse/pulse-service.ts` → `PulseService.recordEngagement()` | ✅ EXISTS | |
| pulse/signal_extractor | `src/pulse/signal-extractor.ts` | ⚠️ PARTIAL | Missing 5 spec signals |
| data/repositories | `src/db/fusion-tables.ts` + `src/character/session-store.ts` | ✅ EXISTS | |
| data/db_models | `src/types/database.ts` + SQL migration files | ✅ EXISTS | |

### TOOLS Layer

| Spec Component | Actual File | Status | Notes |
|---|---|---|---|
| tools/tool_registry | `src/tools/index.ts` | ✅ EXISTS | 21 tools via `bodyHooks` |
| tools/tool_executor | `src/tool-executor.ts` + `src/tool-sandbox.ts` | ✅ EXISTS | Alpha executor with sandbox |
| tools/tool_definitions | `src/tool-definitions.ts` | ✅ EXISTS | 8 curated Alpha schemas |

---

## 2. REACTIVE PIPELINE TRACE

Actual execution path through `src/character/handler.ts → handleMessage()`

| Step | Spec | Actual | File | Status |
|---|---|---|---|---|
| 1 | Receive message | Fastify POST /webhook/telegram → `handleMessage()` | `src/index.ts` | ✅ |
| 2 | Sanitize | `sanitizeInput()` + `isPotentialAttack()` | `src/character/sanitize.ts` | ✅ |
| 3 | Get/create user | `getOrCreateUser()` | `src/character/session-store.ts` | ✅ |
| 4 | Rate limit | `checkRateLimit()` | `src/character/session-store.ts` | ✅ |
| 5 | Get session | `getOrCreateSession()` | `src/character/session-store.ts` | ✅ |
| 6 | Classify (8B NLU) | `classifyMessage()` — Groq llama-3.1-8b-instant | `src/cognitive.ts` | ✅ |
| 7 | Parallel context gather | `Promise.all([scoredMemorySearch, searchGraph, loadPreferences, getActiveGoal, agendaPlanner.getStack, pulseService.getState])` | `handler.ts` | ✅ |
| 7b | Check ProactiveState (Fusion) | `fusionReactiveDecision()` called only if `FUSION_ENGINE_ENABLED=true` — **defaults to false** | `handler.ts` line 761 | ⚠️ FEATURE-FLAGGED OFF |
| 8 | Route decision | `brainHooks.routeMessage()` → `src/brain/index.ts` | `src/brain/index.ts` | ✅ |
| 9 | Tool execution | `brainHooks.executeToolPipeline()` → `bodyHooks.executeTool()` | `src/tools/index.ts` | ✅ |
| 10 | Compose prompt | `composeSystemPrompt()` from `alpha-prompt-builder.ts` (lean ~500 tokens) | `src/alpha/alpha-prompt-builder.ts` | ✅ |
| 11 | LLM call | `generateResponse()` via `tierManager.ts` (Groq 70B) | `src/llm/tierManager.ts` | ⚠️ Uses tierManager not AlphaProvider directly |
| 12 | Second call with tool result | Tool result injected into system prompt of same call — not a true second call | `handler.ts` | ⚠️ Single call with injected context, not 2-call |
| 13 | Respond | Return `MessageResponse` | `handler.ts` | ✅ |
| 14 | Async signal writes | `setImmediate()` → pulse, topic intent, agenda, memory queue | `handler.ts` | ⚠️ Signal packet to Fusion only fires if `FUSION_ENGINE_ENABLED=true` |

**Key finding:** The reactive pipeline is functionally complete. The only gap is that `fusionReactiveDecision()` (ProactiveState injection + direction mismatch) is implemented but gated behind `FUSION_ENGINE_ENABLED=false`. Setting this env var to `true` activates it.

---

## 3. PROACTIVE PIPELINE TRACE

| Step | Spec | Actual | File | Status |
|---|---|---|---|---|
| 1 | Sentinel loop starts | `startSentinel()` called from `scheduler.ts` line 58 after migrations | `src/scheduler.ts` | ✅ RUNNING |
| 2 | Load users | `loadSentinelUsersWithContext()` | `src/sentinel/state-store.ts` | ✅ |
| 3 | Collect stimuli | `collectStimulusRefresh()` → weather/traffic/festival | `src/sentinel/collectors.ts` | ⚠️ Only 3 of 6 collectors work |
| 4 | Score stimuli | `computeFusionScore()` — exact spec formula | `src/fusion/scoring.ts` | ✅ |
| 5 | Social overlay | `applySocialOverlay()` | `src/sentinel/social-overlay.ts` | ✅ |
| 6 | Decide FIRE/BUFFER/DROP | `decideSentinelActions()` → `fusionProactiveDecision()` | `src/sentinel/decision-engine.ts` | ✅ |
| 7 | FIRE → write ProactiveState | `executeFire()` → `upsertProactiveState()` | `src/sentinel/delivery.ts` | ✅ |
| 8 | FIRE → send Telegram | `sendProactiveContent()` | `src/channels.ts` | ✅ |
| 9 | BUFFER → write ProactiveState | `executeBuffer()` → `upsertProactiveState()` | `src/sentinel/delivery.ts` | ✅ |
| 10 | Alpha reads ProactiveState on next message | `fusionReactiveDecision()` gated behind `FUSION_ENGINE_ENABLED=false` | `src/fusion/reactive.ts` | ⚠️ FEATURE-FLAGGED OFF |
| 11 | Mode switch PROACTIVE↔REACTIVE | `evaluateModeSwitch()` | `src/sentinel/mode-switch.ts` | ✅ |
| 12 | Pushback protocol | `evaluatePushback()` + `checkRecovery()` | `src/fusion/pushback.ts` | ✅ |

**Key finding:** Sentinel IS running. Proactive FIRE/BUFFER/DROP works. The only gap is that ProactiveState written by Sentinel is not yet read back by Alpha on incoming messages — that path is behind `FUSION_ENGINE_ENABLED=false`.

---

## 4. PULSE ENGINE TRACE

### State Machine — `src/pulse/state-machine.ts`

| Spec | Actual | Status |
|---|---|---|
| PASSIVE 0–24 | `STATE_THRESHOLDS.CURIOUS = 25` → below 25 = PASSIVE | ✅ |
| CURIOUS 25–49 | `CURIOUS=25, ENGAGED=50` | ✅ |
| ENGAGED 50–79 | `ENGAGED=50, PROACTIVE=80` | ✅ |
| PROACTIVE 80–100 | `PROACTIVE=80` | ✅ |
| Decay half-life 24h | `SCORE_DECAY_HALF_LIFE_HOURS = 24` | ✅ |
| Hysteresis | `HYSTERESIS_BUFFER = 5` | ✅ (extra, good) |

### Signal Weights — `src/pulse/constants.ts` vs Spec

| Signal | Spec | Actual | Status |
|---|---|---|---|
| urgency | +14 | +14 | ✅ |
| desire | +10 | +10 | ✅ |
| fastReply | +8 | +8 | ✅ |
| topicPersistence | +7 | +7 | ✅ |
| negative/rejection | −30 | −18 (`SIGNAL_WEIGHTS.rejection`) | 🚫 WRONG VALUE |
| ignored_proactive | −12 | ❌ not implemented | ❌ MISSING |
| slow_reply | −5 | ❌ not implemented | ❌ MISSING |
| tool_commitment | +22 | ❌ not implemented | ❌ MISSING |
| positive | +20 | ❌ not implemented | ❌ MISSING |

### Persistence
- `pulse_engagement_scores` table (PostgreSQL) ✅
- In-memory hot cache in `PulseService` ✅
- `pulse_history` table (migration 005) — append-only audit trail ✅
- DynamoDB secondary store (`src/pulse/dynamodb-store.ts`) — extra, not in spec

---

## 5. SENTINEL LOOP TRACE

### Loop Status: ✅ RUNNING
- `startSentinel()` called from `scheduler.ts` line 58
- 60-second tick interval
- All 12 old cron jobs removed from scheduler — Sentinel is the sole proactive engine

### Collector Status

| Collector | Interval | Status |
|---|---|---|
| `collectStimulusRefresh()` — weather/traffic/festival | every 30 ticks (30 min) | ✅ Works |
| `collectSocialMonitor()` — squad/friend changes | every 15 ticks (15 min) | ❌ Stub → [] |
| `collectTopicFollowup()` — warm topic re-engagement | every 30 ticks (30 min) | ❌ Stub → [] |
| `collectContentScan()` — trending content | every 120 ticks (2 hr) | ❌ Stub → [] |
| `runMemoryProcess()` — memory queue | every tick (1 min) | ✅ Works |
| `runSessionCleanup()` — session summaries + stale topics | every 5 ticks (5 min) | ✅ Works |
| `collectMessMenu()` — hostel meal stimulus | every 30 ticks | ✅ Phase 5 |
| `collectLocalEvents()` — nearby events | every 60 ticks | ✅ Phase 5 |

### Model Provider
- Spec: Ollama Nemotron 70B / Qwen fallback
- Actual: AWS Bedrock (Claude Haiku) → Together AI (Llama 3.3 70B)
- Status: 🚫 VIOLATION — different provider, functionally equivalent

---

## 6. TOOL EXECUTION TRACE

### Active path (handler.ts → brain/index.ts → tools/index.ts)
```
handleMessage()
  → brainHooks.routeMessage()          [src/brain/index.ts]
  → brainHooks.executeToolPipeline()   [src/brain/index.ts]
  → bodyHooks.executeTool(name, params) [src/tools/index.ts]
  → switch(name) → individual tool
  → reflectToolResult() [src/brain/tool-reflection.ts]
  → tool result injected into system prompt (single LLM call)
```

### Alpha caller path (callAlpha — not yet wired into handler)
```
callAlpha()
  → alphaProvider.chatWithTools()      [src/providers/alpha-provider.ts]
  → tool_call detected
  → executeAlphaTool(name, rawArgs)    [src/tool-executor.ts]
  → parseToolArgs()                    [src/tool-arg-schemas.ts]
  → executeThroughSandbox()            [src/tool-sandbox.ts]
  → bodyHooks.executeTool()            [src/tools/index.ts]
  → Alpha Call 2 with tool result      ← true second LLM call
```

### Alpha Tool Name Mapping

| Alpha Name | Legacy Name | Status |
|---|---|---|
| cab_compare | compare_rides | ✅ |
| place_search | search_places | ✅ |
| weather_check | get_weather | ✅ |
| food_finder | compare_food_prices | ✅ |
| price_alert | compare_prices_proactive | ⚠️ Mapped to comparison tool, not persistent alert |
| event_lookup | search_places + type:event injection | ✅ |
| friend_activity | `__stub__` | ❌ STUB |
| set_reminder | `__stub__` | ❌ STUB |

### Tool Result Injection
- Active path: single LLM call with tool result in system prompt — ⚠️ not a true second call per spec
- Alpha caller path: true second LLM call — ✅ but not yet wired into handler.ts

---

## 7. DATA MODEL VALIDATION

### Required Tables vs Actual

| Spec Table | Actual Table | Status |
|---|---|---|
| proactive_state | `proactive_state` (migration 005) | ✅ |
| stimulus_cache | `stimulus_cache` (migration 005) | ✅ |
| tool_results | `tool_results` (migration 005) | ✅ |
| pulse_history | `pulse_history` (migration 005) | ✅ |
| users | `users` (schema.sql) | ✅ |
| prefs | `user_preferences` (memory.sql) | ✅ |
| friends | `user_relationships` (social.sql) | ✅ |

### Infrastructure Violations
- Spec: Qdrant for vector memory → Actual: pgvector in PostgreSQL — 🚫 VIOLATION (functionally equivalent)
- Spec: Neo4j for graph relations → Actual: PostgreSQL relational tables — 🚫 VIOLATION (limited graph traversal)

---

## 8. ARCHITECTURE VIOLATIONS (Verified)

### CRITICAL

**V-01 — Fusion reactive path is feature-flagged off**
- `fusionReactiveDecision()` exists and is correct, but only runs when `FUSION_ENGINE_ENABLED=true`
- Default in `docker-compose.yml`: `FUSION_ENGINE_ENABLED=${FUSION_ENGINE_ENABLED:-false}`
- Impact: ProactiveState written by Sentinel is never injected into Alpha's context. Direction mismatch detection does not run. Alpha↔Sentinel feedback loop is broken in production.
- Fix: Set `FUSION_ENGINE_ENABLED=true` in env AND promote from logging-only to behavior-affecting (currently it only logs, does not inject context)
- Severity: CRITICAL

**V-02 — Alpha caller not wired into handler.ts**
- `callAlpha()` from `src/alpha/alpha-caller.ts` is never called by handler.ts
- handler.ts still uses `brainHooks.routeMessage()` + `generateResponse()` (tierManager)
- Impact: Together/Fireworks providers not used for reactive responses. True 2-call pipeline (tool result as second call) not active. Sandbox not applied.
- Severity: CRITICAL

### MAJOR

**V-03 — Fusion reactive is logging-only, not behavior-affecting**
- Even when `FUSION_ENGINE_ENABLED=true`, the fusion decision output is only logged — it does NOT inject `contextAdditions` into the prompt or `toolResult` into the pipeline
- Code at handler.ts line 762–785: result goes to `log.info()` only
- Fix: After logging, merge `output.contextAdditions` into `toolResultStr` and handle `inject_prefetch` decision
- Severity: MAJOR

**V-04 — Pulse signal weights incomplete and one is wrong**
- `rejection = -18` (spec: −30)
- Missing: `positive (+20)`, `tool_commitment (+22)`, `ignored_proactive (−12)`, `slow_reply (−5)`
- File: `src/pulse/constants.ts` + `src/pulse/signal-extractor.ts`
- Severity: MAJOR

**V-05 — Sentinel collectors: 3 of 6 are stubs**
- `collectSocialMonitor`, `collectTopicFollowup`, `collectContentScan` return []
- Impact: Squad convergence, topic follow-up, and content-driven proactive scenarios cannot fire
- Severity: MAJOR

**V-06 — influence-engine.ts still active in handler.ts**
- `selectStrategy()` imported and called at handler.ts line 53 and 1133
- Used only for `mediaHint` boolean — not for prompt injection (prompt builder skips it)
- Spec says Fusion Engine replaces influence-engine
- Severity: MAJOR (partial — influence-engine no longer affects prompt, but still runs for media hint)

### MINOR

**V-07 — Sentinel model provider diverges from spec**
- Spec: Ollama Nemotron 70B / Qwen. Actual: Bedrock + Together AI
- Severity: MINOR

**V-08 — Vector store is pgvector, not Qdrant**
- Severity: MINOR

**V-09 — Graph store is PostgreSQL, not Neo4j**
- Severity: MINOR

**V-10 — cognitive.ts lives outside alpha/ directory**
- Should be `src/alpha/nlu-extractor.ts`
- Severity: MINOR

**V-11 — mood-engine.ts is dead code**
- `computeMoodWeights` and `getMoodInstruction` are defined but never called anywhere
- File: `src/character/mood-engine.ts`
- Severity: MINOR (dead code, not a violation)

---

## 9. MISSING COMPONENTS

| ID | Component | Layer | Complexity | Broken Dependency |
|---|---|---|---|---|
| GM-01 | Fusion reactive behavior (not just logging) | FUSION | SMALL | Alpha↔Sentinel loop |
| GM-02 | `collectTopicFollowup()` implementation | SENTINEL | MEDIUM | Storyboard 1 topic scenarios |
| GM-03 | `collectSocialMonitor()` implementation | SENTINEL | MEDIUM | Storyboard 1 squad scenarios |
| GM-04 | `collectContentScan()` implementation | SENTINEL | HIGH | Content-driven proactive |
| GM-05 | `friend_activity` tool | TOOLS | MEDIUM | Alpha tool completeness |
| GM-06 | `set_reminder` tool | TOOLS | MEDIUM | Alpha tool completeness |
| GM-07 | Wire `callAlpha()` into handler.ts | ALPHA | LARGE | True 2-call pipeline, Together/Fireworks |
| GM-08 | Pulse signals: positive, tool_commitment, ignored_proactive, slow_reply | PULSE | SMALL | Accurate engagement scoring |

---

## 10. STORYBOARD COMPLIANCE

### Storyboard 1 — Default Proactive Behavior

| Scenario | Status | Blocker |
|---|---|---|
| 8:15 AM rain + ride surge → Sentinel fires | ✅ Works | None — Sentinel running, weather collector works |
| User replies "book rapido" → tool executes | ✅ Works | None |
| 12:30 PM squad going to Meghana Foods | ❌ Blocked | `collectSocialMonitor()` is stub |
| 3:00 PM weekend trek / Nandi Hills topic | ❌ Blocked | `collectTopicFollowup()` is stub |
| 7:00 PM traffic spike → Sentinel fires | ✅ Works | Traffic collector works |
| ProactiveState injected into Alpha on next message | ❌ Blocked | `FUSION_ENGINE_ENABLED=false` + logging-only |

**Storyboard 1 Compliance: ~40%** — weather/traffic proactive works end-to-end; social and topic scenarios blocked by stub collectors

### Storyboard 2 — Pushback → Retry → Back Off

| Scenario | Status | Blocker |
|---|---|---|
| 1st rejection → RETRY_PIVOT, Pulse −18 | ✅ Works | `evaluatePushback(1)` correct |
| 2nd rejection → BACK_OFF, Pulse −18 | ✅ Works | `evaluatePushback(2)` correct |
| Mode switches to REACTIVE | ✅ Works | `evaluateModeSwitch()` correct |
| User returns, pivot detection invalidates stale stimuli | ❌ Blocked | `fusionReactiveDecision()` logging-only |
| Pulse recovery after 3 positive interactions | ✅ Works | `checkRecovery()` correct |
| Proactive resumes after recovery | ✅ Works | Sentinel mode switch handles this |

**Storyboard 2 Compliance: ~70%** — pushback/recovery logic fully correct; pivot detection blocked by feature flag

---

## 11. DEAD MODULE DETECTION

| Module | File | Status |
|---|---|---|
| mood-engine | `src/character/mood-engine.ts` | ⚠️ Dead — exported functions never called anywhere |
| personality.ts | Deleted | ✅ Correctly removed |
| handler-router.ts | `src/character/handler-router.ts` | ⚠️ Dead shim — pure re-export, no logic |
| scout pipeline | `src/scout/index.ts` | ⚠️ Exists but not called from handler.ts |
| old proactiveRunner crons | Removed from scheduler.ts | ✅ Correctly removed |
| 12 individual cron jobs | Removed from scheduler.ts | ✅ Correctly removed |

---

## 12. REFACTOR PLAN

### RF-01 — Promote Fusion reactive from logging to behavior (SMALL)
- File: `src/character/handler.ts` lines 762–785
- Action: After `fusionReactiveDecision()` resolves, merge `output.contextAdditions` into `toolResultStr`; if `output.decision === 'inject_prefetch'` and `output.toolResult`, use it as `toolResultStr`
- Why: ProactiveState written by Sentinel is never read back by Alpha. This is the single most impactful fix.
- Depends on: Nothing

### RF-02 — Set `FUSION_ENGINE_ENABLED=true` in production env
- File: `deploy/docker-compose.prod.yml` line 41
- Action: Change `FUSION_ENGINE_ENABLED=${FUSION_ENGINE_ENABLED:-false}` to `FUSION_ENGINE_ENABLED=true`
- Why: Feature flag defaults to false; Fusion reactive never runs
- Depends on: RF-01 (otherwise enabling the flag only logs, doesn't change behavior)

### RF-03 — Fix Pulse signal weights
- File: `src/pulse/constants.ts` + `src/pulse/signal-extractor.ts`
- Action: Change `rejection` from −18 to −30; add `positive: 20`, `tool_commitment: 22`, `ignored_proactive: -12`, `slow_reply: -5`; add detection logic in signal-extractor
- Depends on: Nothing

### RF-04 — Implement `collectTopicFollowup()` in collectors.ts
- File: `src/sentinel/collectors.ts`
- Action: Query `topic_intents` for warm topics (confidence > 25, inactive > 4h) per userId; return as StimulusInput[]
- Depends on: Nothing

### RF-05 — Implement `collectSocialMonitor()` in collectors.ts
- File: `src/sentinel/collectors.ts`
- Action: Query `squad_intents` for recent squad activity; return convergence stimuli
- Depends on: Nothing

### RF-06 — Wire `callAlpha()` into handler.ts
- File: `src/character/handler.ts`
- Action: Replace `brainHooks.routeMessage()` + `generateResponse()` with `callAlpha()` from `src/alpha/alpha-caller.ts`
- Why: True 2-call pipeline, Together/Fireworks providers, sandbox enforcement
- Depends on: RF-01 (context bundle needs proactive state)

### RF-07 — Delete dead modules
- Files: `src/character/mood-engine.ts`, `src/character/handler-router.ts`
- Action: Delete both; remove `selectStrategy` import from handler.ts (or keep for media hint only)
- Depends on: Nothing

### RF-08 — Move cognitive.ts into alpha/
- File: `src/cognitive.ts` → `src/alpha/nlu-extractor.ts`
- Action: Move file, update all imports
- Depends on: Nothing

---

## 13. IMPLEMENTATION PRIORITY LIST

| # | Action | Effort | What it unlocks |
|---|---|---|---|
| 1 | RF-01: Promote Fusion reactive from logging to behavior in handler.ts | SMALL | ProactiveState injection, direction mismatch, Alpha↔Sentinel loop |
| 2 | RF-02: Set `FUSION_ENGINE_ENABLED=true` in prod env | SMALL | Activates RF-01 in production |
| 3 | RF-03: Fix Pulse signal weights (rejection −18→−30, add 4 missing) | SMALL | Accurate engagement scoring |
| 4 | RF-04: Implement `collectTopicFollowup()` | MEDIUM | Storyboard 1 topic/trek scenarios |
| 5 | RF-05: Implement `collectSocialMonitor()` | MEDIUM | Storyboard 1 squad lunch scenario |
| 6 | RF-06: Wire `callAlpha()` into handler.ts | LARGE | True 2-call pipeline, Together/Fireworks, sandbox |
| 7 | RF-07: Delete dead modules (mood-engine, handler-router) | SMALL | Clean codebase |
| 8 | RF-08: Move cognitive.ts → alpha/nlu-extractor.ts | SMALL | Clean module boundaries |
| 9 | Implement `friend_activity` tool | MEDIUM | Alpha tool completeness |
| 10 | Implement `set_reminder` tool | MEDIUM | Alpha tool completeness |
| 11 | Implement `collectContentScan()` | LARGE | Content-driven proactive scenarios |

---

## SUMMARY

The architecture is substantially more complete than the previous report indicated. Key corrections:

- Sentinel IS running — `startSentinel()` is called from `scheduler.ts`
- `personality.ts` IS deleted — handler.ts uses `alpha-prompt-builder.ts`
- mood-engine and influence-engine are NOT injected into prompts — the new prompt builder explicitly skips them
- All 12 old cron jobs ARE removed — scheduler.ts was fully refactored

The real gaps are:
1. `fusionReactiveDecision()` exists and is correct but is logging-only (feature-flagged off) — **one env var + ~10 lines of code to activate**
2. `callAlpha()` exists and is correct but handler.ts still uses the legacy brainHooks path — **large refactor**
3. Three Sentinel collectors are stubs — social, topic followup, content scan
4. Five Pulse signal weights are missing or wrong

Items 1 and 2 in the priority list are the highest-leverage fixes — they activate the entire Fusion Engine with minimal code changes.
