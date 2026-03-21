# Phase 2A + 2B: Developer Guide & Evaluation Metrics

---

## Overview

**Phase 2A** rewrites the user-facing pipeline: 22-step handler → 5-step Alpha pipeline with native function calling. Replaces the 8B classifier (`cognitive.ts`) + Scout reflection pass with a single Alpha 70B call that does NLU + tool calling + response generation.

**Phase 2B** migrates inference providers for scalability and adds per-user concurrency. Runs in parallel with 2A since it's infrastructure-level.

**Critical rule:** The old handler is preserved as `handler-legacy.ts` with a feature flag. At no point is the old code deleted — it remains as instant rollback.

---

## Phase 2A: Alpha Rewrite — The Reactive Pipeline

### Issues: #124, #126, #129, #131, #134

### What exists today (understand before changing)

| File | Lines | What it does |
|------|-------|-------------|
| `src/character/handler.ts` | 1,641 | 22-step pipeline: sanitize → classify(8B) → conditional memory/graph → route → Scout tool pipeline → compose prompt → Groq 70B → filter → store |
| `src/cognitive.ts` | ~600 | 8B classifier: `classifyMessage()` returns complexity, needsTool, toolHint, emotion, goal |
| `src/scout/` | 5 files | Reflection pass: takes tool output, normalizes, reflects for quality, caches |
| `src/hook-registry.ts` | 48 | Singleton: `getBrainHooks()` → `executeScoutPipeline()`, `getBodyHooks()` → `executeTool()` |
| `src/hooks.ts` | ~100 | Type interfaces: `RouteContext`, `RouteDecision`, `ToolResult`, `BrainHooks`, `BodyHooks` |
| `src/tools/index.ts` | ~100 | 20 tool registrations with Groq-compatible definitions + switch dispatch |
| `src/llm/tierManager.ts` | ~200 | Tier 1 (8B: classify) + Tier 2 (70B: respond) with fallback chains |
| `src/personality.ts` | ~300 | 8-layer system prompt composition |
| `src/fusion/` | 7 files | Phase 1 Fusion Engine (currently logging in parallel) |

### What gets built (5 sub-issues, execute in order)

---

#### Issue #129 — Tool Definitions (Dev4, can start immediately)

**Create:** `src/alpha/tool-definitions.ts`

Convert the 20 existing Groq tool definitions from `src/tools/index.ts` into a standalone module that Alpha's function calling can consume. The definitions already exist as `Groq.Chat.CompletionCreateParams.Tool[]` — extract them into a clean export.

**Key tools to prioritize for Alpha function calling:**
- `compare_rides` — cab price comparison (Uber/Ola/Rapido)
- `search_places` — Google Places search
- `get_weather` — OpenWeatherMap
- `search_swiggy_food` / `search_zomato` — food ordering
- `get_directions` — Google Maps directions
- `compare_food_prices` / `compare_grocery_prices` — price comparison

**Create:** `src/alpha/tool-executor.ts`

Map function call names → existing `src/tools/` implementations. This is essentially a refactored version of the `executeTool` switch in `src/tools/index.ts`, but with added logging and Fusion Engine integration.

**Files to read first:**
- `src/tools/index.ts` (existing tool definitions + dispatch)
- `src/hooks.ts` (existing `ToolExecutionResult` type)

**Evaluation — Dev4 marks #129 complete when:**

```
LOG EVIDENCE:
  [Alpha/Tools] Registered 20 tool definitions (8 priority + 12 standard)
  [Alpha/Tools] Schema validation: 20/20 tools pass Groq function schema check

TEST EVIDENCE:
  npx tsc --noEmit                     → 0 errors
  npm run test -- src/alpha/tool       → all tests pass
  Each tool definition validates against Groq's JSON Schema spec
  Tool executor handles: valid call, unknown tool name, malformed args, execution error
```

---

#### Issue #131 — Tool Sandbox (Dev3/Dev4, alongside #129)

**Create:** `src/alpha/tool-sandbox.ts`

Pre-execution validation layer between Alpha's function call output and actual tool execution. This is critical because Groq has a ~5-8% malformed JSON rate on function calls.

**Must handle:**
1. **Schema validation** — check args match tool definition's required/optional params
2. **Type coercion** — Groq 8B/70B sometimes emits numbers as strings (see `coerceToolArgs` in `cognitive.ts` line 38)
3. **JSON repair** — attempt to fix malformed JSON before rejecting (truncated strings, missing braces)
4. **Phantom tool rejection** — tool name not in schema → reject immediately
5. **Rate limiting** — max N calls per tool per user per minute
6. **Error recovery** — malformed → repair attempt → retry once → fail gracefully with user-friendly message

**Files to read first:**
- `src/cognitive.ts` lines 38-80 (existing `coerceToolArgs` — migrate this logic)
- `src/types/schemas.ts` (existing Zod schemas for LLM output validation)

**Evaluation — Dev3/Dev4 marks #131 complete when:**

```
LOG EVIDENCE (on tool call message):
  [Alpha/Sandbox] Validating tool call: compare_rides {from: "Koramangala", to: "Whitefield"}
  [Alpha/Sandbox] Schema check: PASS
  [Alpha/Sandbox] Executing: compare_rides

LOG EVIDENCE (on malformed JSON):
  [Alpha/Sandbox] Schema check: FAIL — missing required field "to"
  [Alpha/Sandbox] Repair attempt: injected default from user context
  [Alpha/Sandbox] Retry: PASS

LOG EVIDENCE (on phantom tool):
  [Alpha/Sandbox] REJECTED phantom tool: "book_flight_now" — not in schema

TEST EVIDENCE:
  npm run test -- src/alpha/sandbox   → all tests pass
  Test cases cover: valid call, missing required arg, wrong type, phantom tool,
                    malformed JSON repair, rate limit exceeded, execution timeout
```

---

#### Issue #134 — Context Window Management (Dev3)

**Create:** `src/alpha/context-manager.ts`

Token budget system that ensures Alpha's context window stays within limits. The current handler has no budget enforcement — it concatenates everything and hopes for the best.

**Token budget (8,192 total for Llama 70B on Groq):**

| Slot | Budget | Source |
|------|--------|--------|
| soul.md | ~500 | `config/soul-v2.md` |
| User context | ~1,000 | Preferences, profile, location |
| ProactiveState | ~300 | From `proactive_state` table (Fusion injects) |
| Pulse + Topics | ~200 | Engagement state, recent topic intents |
| Session history | ~1,500 | Rolling 6-8 messages |
| Tool results | ~800 | Compressed tool output |
| **Remaining for response** | ~3,892 | |

**Must implement:**
1. **Token counting** — use `tiktoken` or character-based estimation (1 token ≈ 4 chars for Llama)
2. **Tool result compression** — raw tool output (can be 2000+ tokens) → structured summary within 800 tokens
3. **History truncation** — rolling window, newest messages prioritized, system messages preserved
4. **Budget overflow handling** — if over budget, trim in priority order: history → tool results → user context → ProactiveState

**Files to read first:**
- `src/personality.ts` (current prompt composition, see how it builds layers)
- `src/character/handler.ts` lines 700-900 (prompt composition section)

**Evaluation — Dev3 marks #134 complete when:**

```
LOG EVIDENCE (on every message):
  [Alpha/Context] Budget: soul=487 ctx=823 proactive=0 pulse=156 history=1204 tools=0 total=2670/8192

LOG EVIDENCE (on tool call with large result):
  [Alpha/Context] Tool result compressed: 2,340 → 780 tokens (compare_rides)
  [Alpha/Context] Budget: soul=487 ctx=823 proactive=0 pulse=156 history=1204 tools=780 total=3450/8192

LOG EVIDENCE (on budget overflow):
  [Alpha/Context] OVERFLOW: 8,540/8,192 — trimming history (1,504 → 1,156 tokens)
  [Alpha/Context] Budget after trim: 8,192/8,192

TEST EVIDENCE:
  npm run test -- src/alpha/context    → all tests pass
  Test: empty context → within budget
  Test: max history + large tool result → truncated to fit
  Test: ProactiveState injection → counted in budget
  Test: compression reduces tool output by ≥50%
```

---

#### Issue #126 — Groq Function Calling in Alpha (Dev3, after #129)

**Modify:** `src/llm/tierManager.ts`

Replace the 2-step LLM flow:
- **Old:** 8B classify (`cognitive.ts`) → Scout execute → 70B respond (`tierManager.ts`)
- **New:** 70B Alpha Call 1 (NLU + tool decision + response OR tool_call) → Sandbox → Execute → Alpha Call 2 (with tool result)

The Alpha call uses `tools` parameter in the Groq API (already supported — see `CallOptions.tools` in tierManager.ts line 36).

**Create:** `src/alpha/alpha-caller.ts`

Single module that:
1. Takes context bundle (from context-manager) + tool definitions (from tool-definitions)
2. Makes Alpha Call 1 with `tool_choice: "auto"`
3. If response has `tool_calls` → sandbox validates → executor runs → Alpha Call 2 with tool result
4. If response has content only → return directly
5. Writes signal packet to Fusion Engine (fire-and-forget)

**Wire Fusion Engine:** The Fusion reactive decision (currently logging only) now feeds into Alpha's context. If `proactiveContext` is present, inject it into the context bundle before Alpha Call 1.

**Files to read first:**
- `src/llm/tierManager.ts` (current LLM calling)
- `src/cognitive.ts` (current 8B classification — what Alpha replaces)
- `src/character/handler.ts` lines 500-700 (classification + tool pipeline section)

**Evaluation — Dev3 marks #126 complete when:**

```
LOG EVIDENCE (simple message, 1 LLM call):
  [Alpha] Call 1: NLU + response (no tool call)
  [Alpha] Provider: groq-70b | Tokens: 487 in / 120 out | Latency: 280ms
  [Alpha] Decision: respond (no tool)

LOG EVIDENCE (tool message, 2 LLM calls):
  [Alpha] Call 1: NLU + tool decision
  [Alpha] Provider: groq-70b | Tokens: 487 in / 85 out | Latency: 220ms
  [Alpha] Tool call: compare_rides {from: "Koramangala", to: "Whitefield"}
  [Alpha/Sandbox] Validating: compare_rides — PASS
  [Alpha/Tools] Executing: compare_rides — 1,240ms
  [Alpha] Call 2: Response with tool result
  [Alpha] Provider: groq-70b | Tokens: 1,267 in / 180 out | Latency: 310ms

LOG EVIDENCE (with Fusion proactive context):
  [Fusion/Reactive] user=xxx route=inject_prefetch proactive=1
  [Alpha/Context] ProactiveState injected: weather/rain_alert (score=0.85)
  [Alpha] Call 1: NLU + response (proactive context included)

METRIC EVIDENCE:
  Simple message: 1 LLM call, <400ms total
  Tool message: 2 LLM calls, <800ms total
  No 8B classify call in logs (cognitive.ts bypassed)
```

---

#### Issue #124 — Handler Rewrite (Dev3, after #126 working)

**Create:** `src/character/handler-alpha.ts` (new 5-step handler)
**Preserve:** `src/character/handler.ts` → rename to `src/character/handler-legacy.ts`
**Create:** `src/character/handler-router.ts` (feature flag switch)

**The 5-step pipeline:**

```
Step 1: RECEIVE
  Parse webhook → extract message/userId/chatId
  (Same as current handler steps 0-3)

Step 2: GATHER (parallel, ~50ms)
  Promise.all([
    vectorMemory(Qdrant),      // src/memory-store.ts
    graphContext(Neo4j),        // src/graph-memory.ts
    preferences(PostgreSQL),   // src/memory.ts
    proactiveState(Fusion),    // src/fusion/reactive.ts (NOW ACTIVE, not just logging)
    pulseState + topicIntents  // src/pulse/
  ])

Step 3: ALPHA CALL 1
  contextManager.buildContext(soul-v2, gathered, proactiveState)
  alphaCaller.call(context, toolDefinitions)
  → Returns: response text OR tool_call

Step 4: TOOL? (conditional)
  If tool_call → sandbox.validate() → executor.run() → ALPHA CALL 2 with result
  If no tool → skip to Step 5

Step 5: RESPOND + WRITE (fire-and-forget)
  Send response to Telegram
  Promise.all([  // fire-and-forget, don't await
    pulseService.update(delta),
    signalPacket.write(extractedSignals),
    enqueueMemoryWrite(message, response),
    updatePreferences(detected),
    updateSession(messages)
  ])
```

**Feature flag:** `ALPHA_HANDLER_ENABLED`
- `false` (default): uses `handler-legacy.ts` (current 22-step)
- `true`: uses `handler-alpha.ts` (new 5-step)

**handler-router.ts:**
```typescript
export async function handleMessage(params) {
  if (process.env.ALPHA_HANDLER_ENABLED === 'true') {
    return handleMessageAlpha(params)
  }
  return handleMessageLegacy(params)
}
```

**Files to read first:**
- `src/character/handler.ts` (entire file — understand all 22 steps)
- `src/character/index.ts` (entry point that calls handler)
- `src/personality.ts` (prompt composition — replaced by context-manager + soul-v2)

**Evaluation — Dev3 marks #124 complete when:**

```
LOG EVIDENCE (simple message, new handler):
  [Handler/Alpha] Step 1: RECEIVE user=xxx message="hey what's up"
  [Handler/Alpha] Step 2: GATHER parallel (52ms) — memory=3 graph=1 prefs=5 proactive=0 pulse=PASSIVE
  [Alpha/Context] Budget: soul=487 ctx=823 proactive=0 pulse=156 history=1204 tools=0 total=2670/8192
  [Alpha] Call 1: NLU + response (no tool call)
  [Alpha] Provider: groq-70b | Tokens: 2670 in / 120 out | Latency: 280ms
  [Handler/Alpha] Step 5: RESPOND (180 chars) + 5 fire-and-forget writes
  [Pulse] user=xxx state=PASSIVE score=0 delta=+8
  [Fusion/Reactive] user=xxx route=respond confidence=1.00 proactive=0

LOG EVIDENCE (tool message, new handler):
  [Handler/Alpha] Step 1: RECEIVE user=xxx message="compare cab prices to Whitefield"
  [Handler/Alpha] Step 2: GATHER parallel (48ms) — memory=2 graph=0 prefs=5 proactive=0 pulse=ENGAGED
  [Alpha] Call 1: NLU + tool decision
  [Alpha] Tool call: compare_rides {from: "Koramangala", to: "Whitefield"}
  [Alpha/Sandbox] Validating: compare_rides — PASS
  [Alpha/Tools] Executing: compare_rides — 1,240ms
  [Alpha/Context] Tool result compressed: 2,340 → 780 tokens
  [Alpha] Call 2: Response with tool result — 310ms
  [Handler/Alpha] Step 5: RESPOND (420 chars) + 5 fire-and-forget writes

LOG EVIDENCE (proactive injection, new handler):
  [Handler/Alpha] Step 2: GATHER parallel (55ms) — memory=2 graph=1 prefs=5 proactive=1 pulse=ENGAGED
  [Fusion/Reactive] user=xxx route=respond confidence=0.75 proactive=1 invalidated=0
  [Alpha/Context] ProactiveState injected: weather/rain_alert (287 tokens)
  [Alpha] Call 1: NLU + response (proactive context woven in)

LOG EVIDENCE (feature flag rollback):
  [Handler] Using legacy handler (ALPHA_HANDLER_ENABLED=false)
  (... normal 22-step logs ...)

METRIC EVIDENCE (run 20 test messages through both handlers):
  Simple messages:  Alpha avg <400ms, 1 LLM call  |  Legacy avg ~600ms, 2 LLM calls
  Tool messages:    Alpha avg <800ms, 2 LLM calls  |  Legacy avg ~1200ms, 3 LLM calls
  Response quality: Alpha responses ≥ Legacy quality (subjective check on 20 messages)
  Zero dropped messages: 20 sent → 20 responded

REGRESSION EVIDENCE:
  ALPHA_HANDLER_ENABLED=false → bot works exactly as before
  ALPHA_HANDLER_ENABLED=true → all message types work (text, location, voice, /command, callback)
  No broken Telegram HTML/Markdown rendering
```

---

### Phase 2A — Completion Checklist

A dev marks Phase 2A as **COMPLETE** only when ALL of these are true:

| # | Criterion | How to verify |
|---|-----------|--------------|
| 1 | `npx tsc --noEmit` passes | Run it |
| 2 | All existing tests pass | `npm run test` |
| 3 | All new Alpha tests pass | `npm run test -- src/alpha/` |
| 4 | Simple message: 1 LLM call, <400ms | Send "hey" with `ALPHA_HANDLER_ENABLED=true`, check logs |
| 5 | Tool message: 2 LLM calls, <800ms | Send "compare cab prices to Koramangala", check logs |
| 6 | Sandbox catches malformed JSON | Unit test covers this |
| 7 | Context stays within 8,192 token budget | `[Alpha/Context] Budget:` line never exceeds 8192 |
| 8 | Fusion proactive injection works | Insert `proactive_state` row → send message → `proactive=1` in logs |
| 9 | Feature flag rolls back cleanly | Set `ALPHA_HANDLER_ENABLED=false` → old behavior returns |
| 10 | 20 diverse messages pass through both handlers | Manual test, compare quality |
| 11 | No `[cognitive]` or `[Scout]` log lines when Alpha handler is active | grep logs for absence |
| 12 | Fire-and-forget writes land in DB within 2s | Check `signal_packets`, `pulse_history` after sending message |

---

## Phase 2B: Provider Migrations + Concurrency

### Issues: #140, #141, #139

### What exists today

| File | What it does |
|------|-------------|
| `src/llm/tierManager.ts` | Tier 1: Groq 8B → Groq 70B → Gemini Flash fallback chain. Tier 2: Groq 70B → Gemini Flash. No function calling in the provider layer. |
| No provider abstraction | Groq SDK is directly imported everywhere. No pluggable provider system. |
| No concurrency control | Messages processed as they arrive. Same user's messages can race. |

**Note:** All references to Ollama in planning docs are replaced by **AWS Bedrock** (for Sentinel real-time scoring) and **Together AI Batch** (for bulk scoring). Ollama is NOT used.

---

#### Issue #140 — Alpha Provider Migration (Dev4)

**Create:** `src/llm/providers/alpha-provider.ts`

Provider abstraction layer for Alpha (user-facing model). Must support function calling.

**Provider chain (in failover order):**
1. **Together AI** — OpenAI-compatible API, native function calling, higher concurrency (600 RPM)
2. **Fireworks AI** — fallback, also OpenAI-compatible
3. **Groq** — current provider, kept as final fallback

**Interface:**

```typescript
interface AlphaProvider {
  name: string
  call(messages: ChatMessage[], opts: AlphaCallOptions): Promise<AlphaResponse>
  supportsTools: boolean
}

interface AlphaCallOptions {
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'none'
  maxTokens?: number
  temperature?: number
  jsonMode?: boolean
}

interface AlphaResponse {
  content: string | null
  toolCalls: ToolCall[] | null
  provider: string
  latencyMs: number
  tokensIn: number
  tokensOut: number
}
```

**Failover logic:**
- Try primary provider (Together)
- On timeout (>5s) or 5xx → try next provider
- On 429 (rate limit) → try next provider immediately
- On auth error (401/403) → skip provider permanently for this session
- Log every failover with reason

**Files to read first:**
- `src/llm/tierManager.ts` (current Groq calling pattern)
- `src/tools/index.ts` lines 1-30 (existing Groq tool definition format)

**Environment variables to add:**
```
TOGETHER_API_KEY=
TOGETHER_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
FIREWORKS_API_KEY=
FIREWORKS_MODEL=accounts/fireworks/models/llama-v3p3-70b-instruct
```

**Evaluation — Dev4 marks #140 complete when:**

```
LOG EVIDENCE (normal flow):
  [Alpha/Provider] Using together-ai (primary)
  [Alpha/Provider] together-ai response: 280ms, 487 in / 120 out

LOG EVIDENCE (failover):
  [Alpha/Provider] together-ai FAILED: 503 Service Unavailable
  [Alpha/Provider] Failover → fireworks-ai
  [Alpha/Provider] fireworks-ai response: 340ms, 487 in / 120 out

LOG EVIDENCE (rate limit failover):
  [Alpha/Provider] together-ai RATE LIMITED: 429
  [Alpha/Provider] Failover → fireworks-ai (immediate, no backoff)

LOG EVIDENCE (full chain exhaustion):
  [Alpha/Provider] together-ai FAILED: 503
  [Alpha/Provider] fireworks-ai FAILED: timeout 5000ms
  [Alpha/Provider] groq FALLBACK: response 220ms
  [Alpha/Provider] WARNING: All primary providers failed, using Groq fallback

METRIC EVIDENCE:
  Together AI: function calling works with all 20 tool definitions
  Fireworks AI: function calling works with all 20 tool definitions
  Groq: function calling works (already verified)
  Failover latency overhead: <100ms (time to detect failure + switch)

TEST EVIDENCE:
  npm run test -- src/llm/providers    → all tests pass
  Test: primary succeeds → returns result
  Test: primary fails → failover succeeds → returns result
  Test: all fail → throws with aggregated error
  Test: rate limit → immediate failover (no backoff delay)
  Test: function calling → tool_calls parsed correctly from each provider
```

---

#### Issue #141 — Sentinel Provider Migration (Dev4)

**Create:** `src/llm/providers/sentinel-provider.ts`

Provider for Sentinel (background scoring model). Does NOT need function calling — only structured JSON output for scoring decisions.

**Provider chain:**
1. **AWS Bedrock** — real-time scoring (Claude Haiku or Llama on Bedrock). Already partially set up in `setup_bedrock.sh`. Use `AWS_BEDROCK_MODEL_ID` from `.env`.
2. **Together AI Batch** — bulk scoring for 500+ users. Uses Together's batch API for cost efficiency.

**NOT Ollama.** All Ollama references in planning docs are superseded. Bedrock replaces Ollama for real-time, Together Batch replaces it for bulk.

**Interface:**

```typescript
interface SentinelProvider {
  name: string
  score(prompt: string, opts: SentinelOptions): Promise<SentinelScoreResult>
  batchScore(prompts: string[], opts: SentinelOptions): Promise<SentinelScoreResult[]>
}

interface SentinelScoreResult {
  action: 'FIRE' | 'BUFFER' | 'DROP'
  score: number
  reason: string
  latencyMs: number
}
```

**Environment variables (already in .env.example):**
```
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_BEDROCK_REGION=ap-south-1
AWS_BEDROCK_MODEL_ID=anthropic.claude-3-haiku-20240307-v1:0
TOGETHER_API_KEY=              # shared with Alpha provider
```

**Files to read first:**
- `src/fusion/scoring.ts` (the scoring formula Sentinel will use)
- `src/fusion/proactive.ts` (FIRE/BUFFER/DROP logic)
- `config/sentinel-soul.md` (scoring rules prompt)
- `setup_bedrock.sh` (existing Bedrock setup)

**Evaluation — Dev4 marks #141 complete when:**

```
LOG EVIDENCE (real-time scoring):
  [Sentinel/Provider] Scoring stimulus: weather/rain_commute for user=xxx
  [Sentinel/Provider] Using bedrock (real-time)
  [Sentinel/Provider] Result: FIRE score=0.87 reason="rain + commute match" (340ms)

LOG EVIDENCE (batch scoring):
  [Sentinel/Provider] Batch scoring: 50 stimuli across 20 users
  [Sentinel/Provider] Using together-batch
  [Sentinel/Provider] Batch complete: 50 scored in 4,200ms (84ms/stimulus avg)
  [Sentinel/Provider] Results: 8 FIRE, 15 BUFFER, 27 DROP

LOG EVIDENCE (failover):
  [Sentinel/Provider] bedrock FAILED: ThrottlingException
  [Sentinel/Provider] Failover → together-batch (single-item mode)

METRIC EVIDENCE:
  Bedrock single scoring: <500ms per stimulus
  Together Batch: 100 stimuli in <30 seconds
  Structured JSON output parses correctly (action + score + reason)
  sentinel-soul.md loaded as scoring prompt

TEST EVIDENCE:
  npm run test -- src/llm/providers/sentinel    → all tests pass
  Test: real-time score returns valid FIRE/BUFFER/DROP
  Test: batch score returns array of valid results
  Test: Bedrock failure → Together fallback
  Test: invalid model output → default to DROP with reason
```

---

#### Issue #139 — Concurrency Architecture (Dev1/Dev4)

**Create:** `src/concurrency/message-queue.ts`

Per-user message queue ensuring same-user messages are processed sequentially, different-user messages are processed in parallel.

**Rules:**
1. **Same user = sequential** — User A sends "book cab" then "cancel that" → processed in order
2. **Different users = parallel** — User A and User B messages processed simultaneously
3. **Rate limiting per provider** — Together: 600 RPM, Groq: 30 RPM, Bedrock: auto-scales
4. **Queue overflow** — if user queue depth > 5 → reject with "I'm processing your previous messages, one moment"
5. **Per-user lock** — prevent concurrent context writes corrupting state (memories, preferences, session)

**Implementation approach:**
- In-memory `Map<userId, Promise<void>>` chain — each message awaits the previous one for the same user
- Global rate limiter using token bucket per provider
- No external dependencies (no Redis/Bull needed for single-instance)

**Files to read first:**
- `src/character/handler.ts` (current entry point — where queue wraps around)
- `src/character/session-store.ts` (session read/write — where race conditions happen)

**Environment variables:**
```
MAX_CONCURRENT_USERS=50
MAX_QUEUE_DEPTH_PER_USER=5
```

**Evaluation — Dev1/Dev4 marks #139 complete when:**

```
LOG EVIDENCE (sequential same-user):
  [Queue] user=AAA enqueue msg#1 (queue depth: 1)
  [Queue] user=AAA processing msg#1
  [Queue] user=AAA enqueue msg#2 (queue depth: 2, waiting)
  [Queue] user=AAA msg#1 complete (450ms)
  [Queue] user=AAA processing msg#2
  [Queue] user=AAA msg#2 complete (320ms)

LOG EVIDENCE (parallel different-users):
  [Queue] user=AAA enqueue msg#1 (queue depth: 1)
  [Queue] user=BBB enqueue msg#1 (queue depth: 1)
  [Queue] user=AAA processing msg#1
  [Queue] user=BBB processing msg#1  ← PARALLEL, not waiting for AAA
  [Queue] user=BBB msg#1 complete (300ms)
  [Queue] user=AAA msg#1 complete (450ms)

LOG EVIDENCE (queue overflow):
  [Queue] user=AAA enqueue msg#6 — REJECTED (queue depth 5 exceeded)
  [Queue] user=AAA sent overflow response: "Processing your previous messages..."

LOG EVIDENCE (provider rate limit):
  [RateLimit] together-ai: 598/600 RPM — approaching limit
  [RateLimit] together-ai: 600/600 RPM — throttling (queuing requests)
  [RateLimit] together-ai: bucket refilled, resuming

METRIC EVIDENCE:
  50 simultaneous users → all get responses within 5 seconds
  Same user 3 rapid messages → processed in exact order sent
  No DB corruption: session messages never duplicated or lost
  No race conditions: preferences not overwritten by stale data

TEST EVIDENCE:
  npm run test -- src/concurrency    → all tests pass
  Test: 10 concurrent users → all resolve
  Test: same user 3 sequential → order preserved
  Test: queue overflow → graceful rejection
  Test: provider rate limit → requests queued, not dropped
```

---

### Phase 2B — Completion Checklist

A dev marks Phase 2B as **COMPLETE** only when ALL of these are true:

| # | Criterion | How to verify |
|---|-----------|--------------|
| 1 | `npx tsc --noEmit` passes | Run it |
| 2 | All existing tests pass | `npm run test` |
| 3 | All new provider/concurrency tests pass | `npm run test -- src/llm/providers/ src/concurrency/` |
| 4 | Alpha responds via Together AI with function calling | Send tool message, check `[Alpha/Provider] Using together-ai` in logs |
| 5 | Provider failover works | Kill Together API key → Fireworks handles → restore → traffic returns |
| 6 | Sentinel scores via Bedrock | Check `[Sentinel/Provider] Using bedrock` in logs |
| 7 | Sentinel batch scores 100 stimuli in <30s | Run batch test, check timing |
| 8 | 50 simultaneous users get responses within 5s | Load test |
| 9 | Same user sequential ordering preserved | Send 3 rapid messages, verify order in logs |
| 10 | No Ollama references in code | `grep -r "ollama\|Ollama" src/ --include="*.ts"` returns nothing |
| 11 | Feature flags added to docker-compose | `TOGETHER_API_KEY`, `FIREWORKS_API_KEY` in docker-compose.yml |
| 12 | `.env.example` updated with new vars | All new env vars documented |

---

## Server Deployment (Phase 2A + 2B)

After PRs are merged to `dev/fusion-architecture-v2`:

```bash
ssh root@aria-beta
cd ~/personifi-aria

# Pull
git fetch origin && git pull origin dev/fusion-architecture-v2

# Add new env vars
echo '' >> .env
echo '# Phase 2A: Alpha Handler' >> .env
echo 'ALPHA_HANDLER_ENABLED=false' >> .env

echo '' >> .env
echo '# Phase 2B: Provider Migration' >> .env
echo 'TOGETHER_API_KEY=your_key_here' >> .env
echo 'TOGETHER_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo' >> .env
echo 'FIREWORKS_API_KEY=your_key_here' >> .env
echo 'FIREWORKS_MODEL=accounts/fireworks/models/llama-v3p3-70b-instruct' >> .env

# Rebuild
docker compose down
docker compose build --no-cache
docker compose up -d

# Test with legacy handler first (ALPHA_HANDLER_ENABLED=false)
docker compose logs -f aria | grep -E "Handler|Alpha|Fusion|Provider"

# Send test message, verify old handler still works

# Enable Alpha handler
sed -i 's/ALPHA_HANDLER_ENABLED=false/ALPHA_HANDLER_ENABLED=true/' .env
docker compose down && docker compose up -d

# Send test messages, verify new handler logs:
#   [Handler/Alpha] Step 1: RECEIVE ...
#   [Handler/Alpha] Step 2: GATHER parallel ...
#   [Alpha] Call 1: ...
#   [Handler/Alpha] Step 5: RESPOND ...

# If anything breaks, instant rollback:
sed -i 's/ALPHA_HANDLER_ENABLED=true/ALPHA_HANDLER_ENABLED=false/' .env
docker compose down && docker compose up -d
```

---

## File Structure After Phase 2A + 2B

```
src/
  alpha/                          # NEW — Phase 2A
    tool-definitions.ts           # #129 — Groq-compatible function schemas
    tool-executor.ts              # #129 — Function name → tool dispatch
    tool-sandbox.ts               # #131 — Pre-execution validation + repair
    context-manager.ts            # #134 — Token budget + compression
    alpha-caller.ts               # #126 — LLM call orchestration (1 or 2 calls)
    alpha-caller.test.ts
    tool-sandbox.test.ts
    context-manager.test.ts
  character/
    handler-alpha.ts              # #124 — New 5-step handler
    handler-legacy.ts             # #124 — Old 22-step handler (renamed from handler.ts)
    handler-router.ts             # #124 — Feature flag switch
    handler.ts                    # Deleted or symlinked to handler-router.ts
  llm/
    providers/                    # NEW — Phase 2B
      alpha-provider.ts           # #140 — Together → Fireworks → Groq chain
      sentinel-provider.ts        # #141 — Bedrock → Together Batch
      alpha-provider.test.ts
      sentinel-provider.test.ts
    tierManager.ts                # Kept for legacy handler compatibility
  concurrency/                    # NEW — Phase 2B
    message-queue.ts              # #139 — Per-user sequential, cross-user parallel
    message-queue.test.ts
  fusion/                         # Phase 1 (already exists)
    reactive.ts                   # Now ACTIVE (not just logging) in handler-alpha
    ...
```

---

## Cross-Phase Dependencies

```
#129 (Tool Definitions)  ──┐
                           ├──→ #126 (Alpha Function Calling) ──→ #124 (Handler Rewrite)
#131 (Tool Sandbox)     ──┘                                          ↑
#134 (Context Manager)  ─────────────────────────────────────────────┘

#140 (Alpha Provider)   ──→ Plugs into #126 (alpha-caller uses provider abstraction)
#141 (Sentinel Provider) ──→ Phase 4 (Sentinel loop uses this)
#139 (Concurrency)      ──→ Wraps #124 (handler-router runs inside queue)
```

**Dev4** can start #129 + #131 + #140 + #141 immediately (no Phase 2A dependencies).
**Dev3** starts #134, then #126 (needs #129), then #124 (needs #126).
**Dev1** starts #139 after #124 exists (wraps around handler-router).
