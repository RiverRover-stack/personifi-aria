# Personifi-Aria: Phased Implementation Plan

## Current → Desired Architecture Migration

**Branch:** `dev/fusion-architecture-v2`
**Repo:** github.com/Adityashandilya555/personifi-aria

---

## Current State Summary

The codebase is a production TypeScript Telegram bot with a **22-step message handler** (1,611 lines in handler.ts), **8-layer personality composition**, **12 independent cron jobs**, **18 discovery tools** with a Scout reflection layer, and a **separate 8B classifier** for tool routing. It uses Groq (8B + 70B), PostgreSQL (30+ tables), Redis, DynamoDB, and pgvector for memory.

**Key pain points:** 3+ LLM calls per message (~800ms), serial processing (blocks users), 2000+ token system prompt, 5 scattered decision gates in handler.ts, mood-engine/influence-engine/cognitive.ts adding complexity without proportional value.

## Desired State Summary

A **dual-model, fusion-centered architecture** with:

- **Alpha (Model 1)** — Groq/Together 70B, user-facing, 1-2 calls per message, ~500 token soul.md, native function calling (replaces 8B classifier + Scout)
- **Sentinel (Model 2)** — Bedrock/Together Batch, background intelligence, single unified loop replacing 12 cron jobs
- **Fusion Engine** — Central nervous system, dual-mode (reactive per-message + proactive cron-based), replaces 5 handler gates
- **Pulse** — Health metric FSM (PASSIVE/CURIOUS/ENGAGED/PROACTIVE), drives mode switching
- **Data Layer** — PostgreSQL (proactive_state, stimulus_cache, tool_results, pulse_history), Qdrant, Neo4j

**Modules to kill:** mood-engine.ts, influence-engine.ts, cognitive.ts (8B classifier), Scout pipeline, 8-layer personality.ts, 5 handler gates, proactiveRunner.ts, scheduler.ts (12 crons)

**Target:** 22 steps → 5 steps, 3+ LLM calls → 1-2, ~800ms → ~300ms, 2000+ tokens → ~500 tokens

---

## Gap Analysis

| Component | Status | Description |
|-----------|--------|-------------|
| fusion-engine.ts | **Create** | Central routing: reactive mode (per-message) + proactive mode (cron-based). Replaces 5 gates. |
| soul.md | **Create** | ~500 token Alpha personality. Replaces 8-layer personality.ts |
| sentinel-soul.md | **Create** | ~300 token Sentinel rules. Scoring logic, fire thresholds |
| Sentinel background loop | **Create** | Single unified loop absorbing 12 cron jobs |
| proactive_state table | **Create** | Sentinel writes, Alpha reads. Stimulus → user mapping |
| stimulus_cache table | **Create** | TTL-based cache for weather/traffic/events |
| tool_results table | **Create** | Pre-fetched tool results (cab prices, etc.) |
| pulse_history table | **Create** | Score + state + delta audit trail |
| signal_packets table | **Create** | Alpha writes signals for Sentinel to read |
| handler.ts | **Rewrite** | 22 steps → 5-step reactive pipeline |
| cognitive.ts | **Remove** | 8B classifier fully replaced by Alpha function calling |
| personality.ts | **Remove** | 8-layer composition replaced by soul.md |
| Scout pipeline (5 files) | **Remove** | Reflection pass replaced by Alpha function calling |
| mood-engine.ts | **Remove** | Personality modes replaced by Pulse state |
| influence-engine.ts | **Remove** | Strategy layer replaced by direct Pulse read |
| proactiveRunner.ts | **Remove** | Replaced by Sentinel + Fusion proactive mode |
| scheduler.ts | **Remove** | 12 crons absorbed by Sentinel loop |
| Tool definitions | **Create** | Groq-compatible function schemas for 8 tools |
| Tool sandbox | **Create** | Validation + rate limiting between LLM output and execution |
| Context window manager | **Create** | Token budget enforcement + tool result compression |
| Provider: Alpha | **Migrate** | Groq → Together AI/Fireworks (concurrency) |
| Provider: Sentinel | **Migrate** | Ollama → Bedrock + Together Batch (scalability) |
| Concurrency model | **Create** | Per-user message queues + rate limiting |
| Telegram Mini Apps | **Create** | Location picker, friend selector, menu upload, trip form |
| Bot command registration | **Create** | setMyCommands, MenuButton, consistent parse mode |
| Onboarding flow | **Modify** | Add entertainment, time preference, dietary, commute dimensions |
| Friend adding UX | **Create** | Mini App selector + invite links + contact picker |
| OCR pipeline | **Create** | Mess menu + event poster extraction |
| Trip planning tool | **Create** | Composite tool orchestrating parallel fetches |
| Pulse mode switching | **Modify** | Add Fusion mode switching + Sentinel alerts |
| Integration tests | **Create** | End-to-end validation of full architecture |

---

## Phased Implementation

> **Core principle:** At every phase, verify that Telegram data flows correctly through the system. The Telegram→System data pipeline is the hardest part and must be bulletproof before building on top of it. Each phase has a **Telegram Data Checkpoint** specifically for this.

---

### Phase 0: Database Foundation + Infrastructure

**Goal:** Create all new tables and infrastructure so every other phase has what it depends on.

**Issues:** #127, #128

**Developers:** Dev4

**Entry Criteria:** Access to PostgreSQL, Ollama/Bedrock credentials ready

**Tasks:**

1. **#127 — DB Migrations** (Dev4)
   - Create `proactive_state` table (Sentinel writes, Alpha reads)
   - Create `stimulus_cache` table (TTL-based stimulus data)
   - Create `tool_results` table (pre-fetched tool call results)
   - Create `pulse_history` table (score + state audit trail)
   - Create `signal_packets` table (Alpha → Sentinel signal bridge)
   - Add indexes: user_id + status on proactive_state, user_id + stimulus_key unique
   - Run migrations on dev database

2. **#128 — Ollama Infrastructure** (Dev4)
   - Install Ollama, pull Nemotron 70B + Qwen 72B
   - Create `src/ollama-client.ts` with health check + fallback
   - Verify structured JSON output from both models
   - Note: This may be superseded by #141 (Bedrock migration), but having local Ollama for dev/testing is still valuable

**Checkpoint:**
- [ ] All 5 new tables exist with correct schemas and indexes
- [ ] `INSERT INTO proactive_state` + `SELECT` round-trip works
- [ ] Ollama responds to structured scoring prompt with valid JSON
- [ ] Existing Telegram bot still works (regression check: send "hello" → get response)

**Telegram Data Checkpoint:**
- [ ] Send a message to Telegram bot → verify it hits the webhook → verify user record exists in DB → verify message stored in sessions table

**Estimated Complexity:** S (1-2 days)

---

### Phase 1: Fusion Engine + Soul Files (Core Architecture Spine)

**Goal:** Build the central nervous system (Fusion Engine) and the simplified personality files. This is the architectural spine everything else plugs into.

**Issues:** #119, #120

**Developers:** Dev1

**Entry Criteria:** Phase 0 complete (tables exist)

**Tasks:**

1. **#119 — Fusion Engine** (Dev1)
   - Create `src/fusion-engine.ts` with two modes:
     - **Reactive mode:** Check proactive_state → merge context → route decision (execute_tool / inject_prefetch / respond) → return decision to Alpha
     - **Proactive mode:** Read Sentinel scores → apply threshold logic (≥0.8 FIRE, 0.6-0.8 BUFFER, <0.6 DROP) → mode switching based on Pulse state
   - Implement scoring formula: `score = Σ stimulus_w × pref_match(U,S) × receptivity(U) × (1-fatigue(U))`
   - Implement mode switching: PROACTIVE(80+) → aggressive, ENGAGED(50-79) → balanced, CURIOUS(25-49) → cautious (0.85 threshold), PASSIVE(0-24) → minimal (0.9 threshold)
   - Wire into existing handler.ts as a **parallel addition** (don't replace gates yet — add Fusion alongside them so we can A/B test)

2. **#120 — Soul Files** (Dev1)
   - Create `config/soul.md` (~500 tokens): Core identity, tone rules, social awareness, response style
   - Create `config/sentinel-soul.md` (~300 tokens): Scoring rules, fire thresholds, fatigue logic, social cascade rules
   - Wire soul.md into system prompt builder as an option (don't replace personality.ts yet)

**Checkpoint:**
- [ ] `fusionEngine.reactiveDecision(input)` returns correct routing for: no-tool message, tool-call message, pre-fetched result available
- [ ] `fusionEngine.proactiveDecision(stimulus, user)` correctly returns FIRE/BUFFER/DROP based on score thresholds
- [ ] soul.md produces coherent responses when used as system prompt with Groq 70B
- [ ] Existing 22-step pipeline still works (Fusion is additive, not replacing yet)

**Telegram Data Checkpoint:**
- [ ] Send message → handler processes with BOTH old pipeline and Fusion engine in parallel → log Fusion decision → compare to old gate decisions → verify they would produce equivalent or better routing

**Estimated Complexity:** M (3-5 days)

---

### Phase 2A: Alpha Rewrite — The Reactive Pipeline

**Goal:** Replace the 22-step handler with the 5-step pipeline. This is the biggest single change. The entire user-facing message path gets rewritten.

**Issues:** #124, #126, #129, #131, #134

**Developers:** Dev3 (lead), Dev4 (tool definitions)

**Entry Criteria:** Phase 1 complete (Fusion Engine working, soul.md ready)

**Tasks (execute in this order):**

1. **#129 — Tool Definitions** (Dev4, can start immediately)
   - Create `src/tool-definitions.ts` with Groq-compatible function schemas
   - 8 tools: cab_compare, place_search, weather_check, event_lookup, price_alert, food_finder, friend_activity, set_reminder
   - Create `src/tool-executor.ts` mapping function names → existing hook-registry
   - Unit test each tool definition against Groq's schema validator

2. **#131 — Tool Sandbox** (Dev3/Dev4, can start alongside #129)
   - Create `src/tool-sandbox.ts`: pre-execution validation (schema check, arg types, required fields)
   - Add rate limiting per tool per user (prevent runaway tool calls)
   - Add error recovery: malformed JSON → attempt repair → retry once → fail gracefully
   - Handle phantom tool calls (tool name not in schema → reject)
   - Test against known Groq failure modes (~5-8% malformed JSON rate)

3. **#134 — Context Window Management** (Dev3)
   - Create token budget system: soul.md ~500 + context ~1000 + ProactiveState ~300 + Pulse ~200 + history ~1500 = 3500 fixed, leaving ~4500 for tool results
   - Implement tool result compression: raw output → structured summary within 800 token budget
   - Add truncation strategy for session history (rolling 6-8 messages)

4. **#126 — Groq Function Calling in Alpha** (Dev3, after #129 ready)
   - Replace 2-step flow (8B classify → Scout execute) with single Alpha call including function definitions
   - Alpha call 1: NLU + tool decision + response gen (or tool call)
   - If tool_call: sandbox validates → executor runs → Alpha call 2 with result
   - Wire in Fusion Engine for routing decisions
   - Wire in soul.md as system prompt

5. **#124 — Handler Rewrite** (Dev3, after #126 working)
   - Rewrite handler.ts: RECEIVE → GATHER → LLM CALL 1 → TOOL? → LLM CALL 2? → RESPOND → WRITE
   - Step 1: Receive (parse webhook, extract message/userId/chatId)
   - Step 2: Parallel context gather (~50ms): vector memory (Qdrant), graph (Neo4j), prefs (PostgreSQL), ProactiveState (Sentinel-written), Pulse + Topics
   - Step 3: Alpha LLM call with soul.md + context bundle + function definitions
   - Step 4: If tool_call → sandbox → execute → Alpha call 2
   - Step 5: Respond + fire-and-forget writes (Pulse update, topic intent, memory queue, pref signals, session update, social signals)
   - **CRITICAL: Keep the OLD handler as `handler-legacy.ts` with a feature flag** so you can roll back instantly

**Checkpoint:**
- [ ] New 5-step handler processes a simple message ("hey what's up") in <300ms with 1 LLM call
- [ ] New handler processes a tool call message ("compare cab prices to Koramangala") in <500ms with 2 LLM calls
- [ ] Tool sandbox catches malformed JSON and recovers gracefully
- [ ] Context window stays within budget even with large tool results
- [ ] Feature flag can switch between old and new handler instantly
- [ ] Run 20 diverse test messages through both handlers, compare response quality

**Telegram Data Checkpoint:**
- [ ] Send 10 different message types via Telegram (text, location, voice, button callback, /command) → verify ALL reach new handler correctly
- [ ] Verify fire-and-forget writes: after response sent, check that pulse_update, signal_packet, memory_queue entries appear in DB within 2 seconds
- [ ] Verify ProactiveState injection: manually insert a proactive_state row → send a related message → verify Alpha incorporates it
- [ ] Test Telegram parse mode consistency: all responses render correctly (no broken HTML/Markdown)

**Sub-issue needed:** `[Dev3] Create handler feature flag + A/B comparison harness` — allows running old and new handler side-by-side and logging differences

**Estimated Complexity:** XL (7-10 days)

---

### Phase 2B: Provider Migrations + Concurrency (Parallel with 2A)

**Goal:** Swap inference providers for scalability and add per-user concurrency. Can be developed in parallel with Phase 2A since it's infrastructure-level.

**Issues:** #140, #141, #139

**Developers:** Dev4 (providers), Dev1 (concurrency)

**Entry Criteria:** Phase 0 complete

**Tasks:**

1. **#140 — Alpha Provider Migration** (Dev4)
   - Create provider abstraction layer: `src/providers/alpha-provider.ts`
   - Implement Together AI adapter (OpenAI-compatible API, function calling support)
   - Implement Fireworks AI adapter as fallback
   - Keep Groq adapter for comparison/fallback
   - Add automatic failover: Together → Fireworks → Groq
   - Benchmark: latency, throughput, function calling accuracy across providers

2. **#141 — Sentinel Provider Migration** (Dev4)
   - Create `src/providers/sentinel-provider.ts`
   - Implement AWS Bedrock adapter for real-time Sentinel decisions (FIRE/BUFFER/DROP)
   - Implement Together AI batch adapter for bulk scoring (500 users × 20 stimuli)
   - Keep Ollama adapter for local dev/testing
   - Add automatic failover: Bedrock → Together → Ollama

3. **#139 — Concurrency Architecture** (Dev1/Dev4)
   - Implement per-user message queue: same user = sequential, different users = parallel
   - Add rate limiting per provider (Together: 600 rpm, Bedrock: auto-scales)
   - Implement queue overflow handling (backpressure when queue depth > threshold)
   - Add per-user lock to prevent concurrent context writes corrupting state

**Checkpoint:**
- [ ] Alpha responds via Together AI with function calling working correctly
- [ ] Provider failover works: kill Together connection → Fireworks handles traffic → restore Together → traffic returns
- [ ] Sentinel scores 100 users in <30 seconds via Bedrock (vs. hours with Ollama serial)
- [ ] 50 simultaneous messages from different users all get responses within 3 seconds
- [ ] Same user sending 3 rapid messages → processed in order, not jumbled

**Telegram Data Checkpoint:**
- [ ] Under load (50 users sending messages simultaneously), verify NO messages are dropped (count Telegram webhooks received vs. responses sent)
- [ ] Verify per-user ordering: User A sends "book cab" then "cancel that" → processed in order, not reversed

**Estimated Complexity:** L (5-7 days)

---

### Phase 3: Telegram UX Overhaul (The Hard Part)

**Goal:** Build all Mini Apps and UX improvements. This is where Telegram-specific complexity lives. Test every data flow thoroughly — this is the phase where the user emphasized correctness matters most.

**Issues:** #132, #133, #136, #137

**Developers:** Dev3 (lead), Dev1 (onboarding), Dev4 (location backend)

**Entry Criteria:** Phase 2A substantially complete (new handler working for text messages)

**Tasks:**

1. **#132 — Telegram UX Foundation** (Dev3)
   - Register bot commands via `setMyCommands`: /start, /settings, /friends, /locations, /trip, /help
   - Set up `MenuButton` for persistent action menu
   - Fix parse mode: standardize on HTML everywhere (handler + outbound)
   - Distinguish proactive vs. reactive messages visually (different formatting/prefix)
   - Add dismissal mechanism for proactive messages (inline keyboard with "Not now" button)
   - Set up Mini App infrastructure: HTTPS endpoint for webapp hosting, `answerWebAppQuery` handler

2. **#133 — Location Mini App** (Dev3/Dev4)
   - Build `webapp/location-picker.html`: map view (Leaflet/Mapbox), search bar with autocomplete, saved locations list, "Use current location" button
   - Backend: `Telegram.WebApp.sendData()` → bot receives structured location `{area: "Indiranagar", lat: 12.97, lng: 77.64, label: "Home"}`
   - Implement saved locations CRUD (PostgreSQL: user_id, label, area, lat, lng)
   - Replace all reverse-geocode → area-name logic with Mini App structured input
   - Fallback for users who don't open Mini App: old GPS share → improved reverse geocoding

3. **#136 — Enhanced Onboarding** (Dev1/Dev3)
   - Add preference dimensions: entertainment, time preference, dietary restrictions, commute pattern, communication style
   - Implement weighted preferences: initial weights from onboarding, refined by behavior over time
   - Create onboarding Mini App or inline keyboard flow for richer Q&A
   - Verify all preferences write to PostgreSQL `user_preferences` with correct weights

4. **#137 — Friend Adding Mini App** (Dev3)
   - Build `webapp/friend-selector.html`: search by name/username, batch selection, invite links
   - Implement `KeyboardButtonRequestUsers` (Bot API 6.5+) for native contact picking
   - Create invite link system: `/invite` → generates unique link → friend clicks → auto-added
   - Verify friend graph updates in Neo4j after Mini App submission

**Checkpoint (test EVERY Mini App individually):**
- [ ] Location Mini App: open → search "Koramangala" → select → bot receives `{area: "Koramangala", lat: ..., lng: ...}` → saved to DB
- [ ] Location Mini App: "Use current location" → GPS → area extracted → sent to bot → stored
- [ ] Saved locations: save "Home" → next time location asked, "Home" appears in Mini App → select → correct area used
- [ ] Friend Mini App: search friend → select 3 friends → submit → all 3 appear in Neo4j friend graph
- [ ] Invite link: generate → friend clicks → friend auto-added → both users see each other in friend list
- [ ] Bot commands: type "/" in Telegram → see all commands listed → each works
- [ ] MenuButton: tap persistent button → see action menu → each option works
- [ ] Onboarding: new user starts bot → goes through all preference questions → all preferences stored with correct weights in user_preferences table

**Telegram Data Checkpoint (THE CRITICAL ONE):**
- [ ] Mini App sendData() → bot receives via `message.web_app_data.data` → parse → validate → store in correct DB table → confirm to user. Test with: valid data, empty data, malformed data, oversized data
- [ ] Location flow end-to-end: Mini App → structured location → tool call (e.g., food_finder with location) → correct results returned → response shown to user
- [ ] Friend flow end-to-end: Mini App → friend IDs → Neo4j update → Sentinel uses friend graph in next scoring loop → social cascade boost applied correctly
- [ ] Onboarding flow end-to-end: all preferences stored → Sentinel uses preferences in pref_match scoring → proactive messages reflect user's actual preferences
- [ ] Inline keyboard callbacks: "Not now" on proactive message → callback received → proactive_state marked as dismissed → not re-sent
- [ ] Parse mode: test 20 different response types (plain text, links, bold, lists, tool results with special chars) → all render correctly in Telegram
- [ ] Error handling: Mini App fails to load → graceful fallback to text input → still works

**Sub-issues needed:**
- `[Dev3] Mini App data validation + error handling layer` — Validate all sendData() payloads before processing
- `[Dev3/QA] Telegram parse mode audit — Test all response types render correctly` — Go through every response path and verify HTML rendering
- `[Dev3] Mini App fallback for older Telegram clients` — Not all clients support Mini Apps; need graceful degradation

**Estimated Complexity:** XL (8-12 days)

---

### Phase 4: Sentinel + Proactive Intelligence

**Goal:** Build the background intelligence loop that powers proactive behavior — the Sentinel. This is what makes Aria "text first" instead of waiting for the user.

**Issues:** #121, #122

**Developers:** Dev2

**Entry Criteria:** Phase 1 (Fusion Engine), Phase 2B (Sentinel provider), Phase 0 (tables)

**Tasks:**

1. **#121 — Sentinel Background Loop** (Dev2)
   - Build single event-driven loop replacing 12 cron jobs:
     - Stimulus Refresh (weather/traffic/events) — was `*/30m cron × 3`
     - Social Monitor (friend graph changes) — was `*/15m + */30m crons`
     - Topic Followup (stale intents) — was `*/30m cron`
     - Content Scan (trending + relevant) — was `*/2h + */6h crons`
     - Memory Process (queued writes) — was `*/30s cron`
     - Session Cleanup (summarize + trim) — was `*/5m cron`
   - Per-user processing pipeline: Collect Stimuli → Score Each (pref_match × receptivity × freshness) → Social Overlay (squad convergence?) → Decide Action (FIRE/BUFFER/DROP)
   - Output actions:
     - FIRE: write ProactiveState + trigger Alpha delivery via Telegram API
     - BUFFER: write ProactiveState only (Alpha picks up on next user message)
     - PRE-FETCH: call tool API, cache in tool_results, then FIRE/BUFFER
     - DROP: log for analytics, discard
   - Implement fatigue: max 3 proactive messages per user per day (5 if PROACTIVE pulse), 8am-10pm IST window
   - Implement sentinel-soul.md as the scoring personality

2. **#122 — Pulse as Fusion Feedback Loop** (Dev2)
   - Extend Pulse FSM with mode switching: score ≥ 50 → PROACTIVE mode, < 50 → REACTIVE mode
   - Implement transition rules:
     - PROACTIVE → REACTIVE: Sentinel stops FIRing, only BUFFERs
     - REACTIVE → PROACTIVE: requires 3 positive interactions, then softer threshold (0.85)
   - Implement Sentinel alert on ENGAGED → CURIOUS drop (Sentinel re-scans all prefs, finds indoor/comfort stimuli)
   - Wire pulse_delta from Alpha's fire-and-forget writes into Pulse FSM
   - Write pulse_history for every state change

**Checkpoint:**
- [ ] Sentinel loop processes 100 users in <60 seconds (batch scoring via Bedrock)
- [ ] Sentinel correctly scores a weather stimulus: rain + user commutes at 8:45 → score ≥ 0.8 → FIRE
- [ ] Sentinel correctly DROPs a low-relevance stimulus: concert in a genre user doesn't like → score < 0.6
- [ ] FIRE → ProactiveState written → Alpha delivery sends Telegram message → user receives it
- [ ] BUFFER → ProactiveState written → user sends message → Alpha injects buffered context → response reflects it
- [ ] Fatigue: after 3 proactive messages in one day, 4th stimulus with score 0.82 → DROP (fatigue)
- [ ] Pulse mode switch: PROACTIVE user rejects twice → Pulse drops → mode switches to REACTIVE → Sentinel stops FIRing

**Telegram Data Checkpoint:**
- [ ] Proactive message delivery: Sentinel FIRE → Alpha generates message → `bot.sendMessage()` → user receives in Telegram → verify message shows correct stimulus context
- [ ] Proactive message with pre-fetched tool result: Sentinel pre-fetches cab prices → FIRE → Alpha includes prices in message → user sees accurate prices
- [ ] Proactive message dismissal: user taps "Not now" → callback received → proactive_state marked → Sentinel adjusts scoring
- [ ] Buffered context injection: Sentinel BUFFERs comedy show → user asks about entertainment → Alpha injects buffered comedy show context → response is relevant

**Sub-issue needed:**
- `[Dev2] Sentinel stimulus source integration test` — Verify each stimulus source (weather API, traffic API, events, social graph, price trackers, content sources) produces correctly formatted data that Sentinel can score

**Estimated Complexity:** L (5-8 days)

---

### Phase 5: Feature Enrichment

**Goal:** Build the feature-layer tools that depend on the core architecture being in place.

**Issues:** #135, #138

**Developers:** Dev2 (OCR), Dev3/Dev4 (trip planning)

**Entry Criteria:** Phase 2A (new handler), Phase 4 (Sentinel for stimulus consumption)

**Tasks:**

1. **#135 — OCR Pipeline + Admin Dashboard** (Dev2/Dev4)
   - Implement OCR: Tesseract.js (free local) with Google Cloud Vision fallback
   - Build admin upload Mini App or simple web form for mess menu photos + event posters
   - OCR → structured extraction → stimulus_cache table → Sentinel consumes as stimulus
   - Wire mess menu stimulus into Sentinel scoring (e.g., "tonight's mess has paneer" → food pref match)

2. **#138 — Trip Planning Composite Tool** (Dev3/Dev4)
   - Create `plan_trip` composite tool: orchestrates parallel calls to flights, hotels, directions, cab compare
   - Add itinerary persistence: save to PostgreSQL, retrievable later
   - Wire as a Groq function definition so Alpha can call it natively

**Checkpoint:**
- [ ] Upload mess menu photo → OCR extracts items → stored in stimulus_cache → Sentinel includes in next scoring loop
- [ ] "Plan a trip to Goa next weekend" → composite tool fires → flights + hotels + transport fetched in parallel → single formatted response
- [ ] Saved itinerary: plan trip → save → next day ask "show my Goa trip" → itinerary retrieved

**Telegram Data Checkpoint:**
- [ ] OCR admin upload via Telegram: admin sends photo → OCR processes → structured data in DB → Sentinel fires proactive message to relevant users about menu
- [ ] Trip planning output renders correctly in Telegram (formatted, links work, no truncation)

**Estimated Complexity:** M (3-5 days)

---

### Phase 6: Kill Legacy + Cleanup

**Goal:** Remove all deprecated modules now that their replacements are proven working. Only do this AFTER phases 2-5 are verified.

**Issues:** #125, #123

**Developers:** Dev2, Dev3

**Entry Criteria:** All previous phases complete, new handler running as default for ≥3 days with no regressions

**Tasks:**

1. **#125 — Kill cognitive.ts, Scout, personality.ts** (Dev3)
   - Delete `src/cognitive.ts` (593 lines) — 8B classifier fully replaced
   - Delete `src/scout/` directory (5 files) — reflection pass replaced by Alpha function calling
   - Delete personality layers from `src/personality.ts` — replaced by soul.md
   - Migrate any remaining useful utilities (regex fast-paths, tool arg coercion) to utility files
   - Remove all imports and references

2. **#123 — Kill mood-engine, influence-engine, proactiveRunner, scheduler** (Dev2)
   - Delete `src/character/mood-engine.ts` — replaced by Pulse FSM
   - Delete `src/influence-engine.ts` — replaced by direct Pulse read
   - Delete `src/media/proactiveRunner.ts` — replaced by Sentinel + Fusion
   - Delete/gut `src/scheduler.ts` — 12 crons absorbed by Sentinel loop
   - Clean up all dead imports and unused dependencies in package.json

**Checkpoint:**
- [ ] `npm run build` succeeds with zero errors after deletions
- [ ] `handler-legacy.ts` still exists as emergency rollback (don't delete yet)
- [ ] Full regression test: 50 diverse messages produce correct responses
- [ ] No references to deleted modules remain in codebase (`grep -r "mood-engine\|influence-engine\|cognitive\|Scout\|proactiveRunner"` returns nothing)

**Telegram Data Checkpoint:**
- [ ] Run the exact same 50 test messages before and after cleanup — responses should be identical or better
- [ ] Proactive messages still deliver correctly (Sentinel path unaffected)
- [ ] All Mini Apps still work (no broken imports)

**Estimated Complexity:** S (2-3 days)

---

### Phase 7: Integration Testing + Validation

**Goal:** End-to-end validation that the complete system matches the desired architecture and all user board stories pass.

**Issues:** #130

**Developers:** All

**Entry Criteria:** All phases 0-6 complete

**Tasks:**

1. **#130 — Integration Testing + Benchmarking** (All Devs)
   - **Test 1: Reactive — Simple Message** → "hey whats up" → 1 LLM call, <300ms, fire-and-forget writes
   - **Test 2: Reactive — Tool Call** → "compare cab prices to Koramangala" → 2 LLM calls, <500ms
   - **Test 3: Reactive — Pre-fetched Injection** → ProactiveState exists → "how much to Koramangala?" → 0ms tool call (cached)
   - **Test 4: Proactive — Sentinel FIRE** → weather stimulus + commute time → proactive message sent
   - **Test 5: Proactive — Pushback Handling** → user rejects → Pulse -18 → retry with different angle → user rejects again → REACTIVE mode
   - **Test 6: Recovery Protocol** → REACTIVE mode → user re-engages → 3 positive interactions → PROACTIVE unlocked with softer threshold
   - **Test 7: Stale Context Invalidation** → user pivots topic → Alpha detects direction mismatch → invalidates stale ProactiveState → Sentinel recalculates
   - **Test 8: Concurrent Load** → 100 users × 5 messages each → all processed correctly, <3s per response
   - **Test 9: Fatigue Protection** → 5 proactive messages in day → 6th scored 0.85 → DROP (fatigue)
   - **Test 10: Full Day Simulation** → Simulate Storyboard 1 (Happy Day) end to end

**Checkpoint:**
- [ ] All 10 integration tests pass
- [ ] Benchmark: avg response time < 500ms (no tool), < 800ms (with tool)
- [ ] Benchmark: Sentinel loop processes 500 users in < 5 minutes
- [ ] No data loss: 1000 messages sent → 1000 responses received → all writes in DB

**Estimated Complexity:** M (3-5 days)

---

## User Story Traceability Matrix

### Storyboard 1: Default Proactive Behavior (Happy Day)

| Story Step | Required Components | Phase Built | Validated? |
|-----------|-------------------|------------|-----------|
| 8:15 AM — Sentinel detects rain + commute pattern + Rapido surge | Sentinel loop + stimulus_cache + weather API | Phase 4 (#121) | Phase 7 Test 4 |
| Aria proactively warns about rain, offers to book Rapido | Fusion FIRE → Alpha delivery + soul.md tone | Phase 1 (#119) + Phase 4 (#121) | Phase 7 Test 4 |
| User agrees → Aria books cab → fire-and-forget Pulse +22 | Tool executor (cab_compare) + Pulse update | Phase 2A (#126, #129) + Phase 4 (#122) | Phase 7 Test 2 |
| 12:30 PM — Sentinel detects squad at restaurant + food pref match | Sentinel social monitor + Neo4j friend graph + pref_match | Phase 4 (#121) + Phase 3 (#137 for friend graph) | Phase 7 Test 4 |
| Aria tells user squad is at restaurant, offers to notify | Alpha + social signals from context bundle | Phase 2A (#124) | Phase 7 Test 1 |
| 3:00 PM — Sentinel detects topic_intent "weekend trek" shifting + friends mentioned Nandi Hills | Sentinel topic followup + social overlay | Phase 4 (#121) | Phase 7 Test 10 |
| Aria references social graph casually ("Nandi Hills trending in your squad") | Alpha reads graph_neighbors + ProactiveState | Phase 2A (#124) + Phase 4 (#121) | Phase 7 Test 3 |
| 7:00 PM — Traffic alert, commute alternate | Sentinel stimulus + traffic API | Phase 4 (#121) | Phase 7 Test 4 |
| 9:30 PM — Sentinel has stimulus but fatigue check → DROP | Fatigue logic in Sentinel loop | Phase 4 (#121) | Phase 7 Test 9 |
| Day summary: 4 proactive, 5 reactive, 0 user-initiated, Pulse 55→88 | Pulse FSM tracking all interactions | Phase 4 (#122) | Phase 7 Test 10 |

### Storyboard 2: User Pushback → Retry → Back Off

| Story Step | Required Components | Phase Built | Validated? |
|-----------|-------------------|------------|-----------|
| 2:00 PM — Aria suggests comedy show (Pulse 72, ENGAGED) | Sentinel FIRE + Alpha delivery | Phase 4 (#121) | Phase 7 Test 5 |
| User rejects: "nah not in the mood" → Pulse -18 → 54 | Pulse signal processing (rejection: -18) | Phase 4 (#122) | Phase 7 Test 5 |
| RETRY: Aria pivots angle (social bond, lower commitment) | Pushback handling in Fusion + soul.md retry rules | Phase 1 (#119, #120) | Phase 7 Test 5 |
| PATH A: User accepts retry → Pulse recovers → back to ENGAGED | Pulse positive signal (+14 committed) | Phase 4 (#122) | Phase 7 Test 5 |
| PATH B: User rejects again → Pulse 54→36 CURIOUS → REACTIVE mode | Mode switch: ENGAGED → CURIOUS → REACTIVE | Phase 4 (#122) | Phase 7 Test 5 |
| Aria: "All good, enjoy the chill evening" → no more pushing | soul.md graceful backoff + reactive mode | Phase 1 (#120) + Phase 4 | Phase 7 Test 5 |
| REACTIVE MODE: Aria stops initiating, Sentinel only BUFFERs | Fusion mode switching + Sentinel BUFFER-only | Phase 1 (#119) + Phase 4 (#121) | Phase 7 Test 6 |
| 4:30 PM — User comes back with DIFFERENT direction (indoor entertainment) | Alpha detects direction mismatch with stale ProactiveState | Phase 2A (#124) | Phase 7 Test 7 |
| Alpha does NOT inject stale "comedy show" context | ProactiveState invalidation in Fusion reactive mode | Phase 1 (#119) | Phase 7 Test 7 |
| Alpha responds aligned with user's ACTUAL direction | soul.md + context bundle (no stale injection) | Phase 2A (#124) | Phase 7 Test 7 |
| 3 positive interactions → Pulse 58→66 → PROACTIVE unlocked | Recovery protocol: 3 positives in ENGAGED → PROACTIVE | Phase 4 (#122) | Phase 7 Test 6 |
| Proactive resumes on user's NEW direction (food+weather, not comedy show) | Sentinel recalculated, stale ProactiveState invalidated | Phase 4 (#121) | Phase 7 Test 7 |

---

## Sub-Issues Created

| Issue # | Title | Phase | Rationale |
|---------|-------|-------|-----------|
| **#142** | `[Dev3] Handler feature flag + A/B comparison harness` | 2A | Safely switch between old and new handler |
| **#143** | `[Dev3] Mini App data validation + error handling layer` | 3 | Validate all sendData() payloads before processing |
| **#144** | `[Dev3/QA] Telegram parse mode audit` | 3 | Test all response types render correctly in HTML |
| **#145** | `[Dev3] Mini App fallback for older Telegram clients` | 3 | Graceful degradation when Mini Apps aren't supported |
| **#146** | `[Dev2] Sentinel stimulus source integration test` | 4 | Verify each stimulus source produces correct data format |
| **#147** | `[All] Telegram data pipeline smoke test suite` | Cross-phase | Automated test: send message → verify DB writes. Run at every phase. |
| **#148** | `[Dev3] ProactiveState invalidation logic when user pivots` | 2A | Critical for Storyboard 2 Phase 4 (direction mismatch detection) |
| **#149** | `[Dev1] Pulse recovery protocol — 3 positive interactions counter` | 4 | Track positive interactions in REACTIVE mode to unlock PROACTIVE |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation | Phase |
|------|-----------|--------|-----------|-------|
| Groq function calling malformed JSON (~5-8%) | High | Medium | Tool sandbox with repair + retry. Track failure rate. | 2A |
| Together AI latency higher than Groq (~400ms vs ~200ms) | High | Medium | Accept latency tradeoff for concurrency. Cache aggressively. | 2B |
| Mini App sendData() reliability across Telegram clients | Medium | High | Add fallback text input for every Mini App flow. Test on Android, iOS, desktop. | 3 |
| Sentinel loop takes too long with 500+ users | Medium | High | Batch scoring via Bedrock. Skip users with no new stimuli. Parallelize per-user scoring. | 4 |
| Handler rewrite breaks existing conversations | Medium | Critical | Feature flag, keep legacy handler, 3-day burn-in before killing old code | 2A |
| Parse mode inconsistency causes garbled messages | Medium | Medium | Standardize HTML everywhere, parse mode audit sub-issue | 3 |
| Neo4j friend graph doesn't update from Mini App | Low | High | Add explicit write-verification step in Mini App handler | 3 |
| Pulse mode switching creates oscillation (rapid PROACTIVE↔REACTIVE) | Low | Medium | Hysteresis buffer (±5 on boundaries), require 3 positive interactions for recovery | 4 |

---

## Developer Assignment Summary

| Developer | Primary Responsibilities | Phases |
|-----------|------------------------|--------|
| **Dev1** | Fusion Engine, soul files, concurrency, onboarding, Pulse | 1, 2B, 3, 4 |
| **Dev2** | Sentinel loop, Pulse feedback, legacy cleanup, OCR | 4, 5, 6 |
| **Dev3** | Handler rewrite, tool sandbox, Telegram UX, Mini Apps, kill legacy code | 2A, 3, 6 |
| **Dev4** | DB migrations, infrastructure, provider migrations, tool definitions | 0, 2A, 2B |

---

## Execution Timeline (Suggested)

```
Week 1:     Phase 0 (DB + Infra)  ←  All devs can start after this
Week 1-2:   Phase 1 (Fusion + Soul)  [Dev1]
Week 2-4:   Phase 2A (Handler Rewrite)  [Dev3, Dev4]
Week 2-3:   Phase 2B (Providers + Concurrency)  [Dev4, Dev1]  ← PARALLEL with 2A
Week 4-5:   Phase 3 (Telegram UX)  [Dev3, Dev1, Dev4]
Week 4-5:   Phase 4 (Sentinel + Pulse)  [Dev2]  ← PARALLEL with Phase 3
Week 6:     Phase 5 (Features)  [Dev2, Dev3]
Week 6:     Phase 6 (Cleanup)  [Dev2, Dev3]
Week 7:     Phase 7 (Integration Testing)  [All]
```

**Total estimated time: 6-7 weeks with 4 developers working in parallel.**

Phase 2B and Phase 4 can run in parallel with other phases since they don't share files. Phase 3 and Phase 4 can also overlap since Dev3 handles UX while Dev2 handles Sentinel independently.
