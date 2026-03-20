# Personifi-Aria V1: Output-First Multi-Agent Architecture

## Context

Aria is shifting from an **input→output chatbot** to an **output-first autonomous agent**. The agent generates the first output based on stimulus + social graph + tools, and the user reacts. This requires a fundamental architectural shift: instead of waiting for user input and responding, Aria must continuously observe, reason, and proactively act.

The current codebase has strong foundations (20+ tools, 5 MCP clients, graph memory, engagement tracking) but the proactive pipeline is **broken at the fusion layer** — stimuli are detected but never combined with social signals or user context to drive intelligent proactive decisions.

---

## The Architecture: 3 Background Agents + 1 Conversation Agent

```
┌─────────────────────────────────────────────────────────────┐
│                    BACKGROUND (Continuous)                    │
│                                                              │
│  ┌──────────────┐     ┌──────────────────┐                  │
│  │  STIMULUS     │     │  SOCIAL GRAPH     │                 │
│  │  AGENT        │     │  AGENT            │                 │
│  │              │     │                   │                  │
│  │ Weather ──┐  │     │ Track all convos  │                  │
│  │ Traffic ──┤  │     │ Friend activity   │                  │
│  │ Prices  ──┤  │     │ Correlated intent │                  │
│  │ Places  ──┤  │     │ Group plans       │                  │
│  │ Events  ──┘  │     │ Shared interests  │                  │
│  └──────┬───────┘     └────────┬──────────┘                  │
│         │                      │                             │
│         ▼                      ▼                             │
│  ┌──────────────────────────────────────────┐               │
│  │          FUSION ENGINE                    │               │
│  │                                           │               │
│  │  Stimulus signals + Social signals        │               │
│  │  + User preferences + Engagement state    │               │
│  │  + Rejection memory + Time context        │               │
│  │           ↓                               │               │
│  │  Deterministic scoring → Proactive State  │               │
│  │  (per user, continuously updated)         │               │
│  └──────────────────┬───────────────────────┘               │
│                     │                                        │
└─────────────────────┼────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────┐
│              CONVERSATION AGENT (Per User)                    │
│                                                              │
│  Inputs:                                                     │
│  • Proactive State (from Fusion Engine)                      │
│  • User Memory (vector + graph + preferences)                │
│  • SOUL.md personality                                       │
│  • Conversation history                                      │
│                                                              │
│  Behaviors:                                                  │
│  • USER INACTIVE → Use proactive state to initiate           │
│    "It's raining + Rohit said Meghana's biryani is fire      │
│     + you love biryani = order together?"                    │
│  • USER ACTIVE → Enrich conversation with proactive insights │
│    "btw Rohit mentioned this place is overrated"             │
│  • HIGH CONFIDENCE → Initiate tools autonomously             │
│    "Found flights to Goa for ₹3.2k, Priya is interested too"│
│                                                              │
│  Output → Telegram / WhatsApp / Slack                        │
└──────────────────────────────────────────────────────────────┘
```

---

## Model Selection (Researched for Cost + Quality)

### Current Models in Codebase
| Role | Current Model | Current Cost |
|------|--------------|--------------|
| Classifier/Router | Groq Llama 3.1 8B | $0.05/$0.08 per 1M tokens |
| Main Response | Groq Llama 3.3 70B | $0.59/$0.79 per 1M tokens |
| Signal Extraction | AWS Bedrock Claude Haiku | $0.25/$1.25 per 1M tokens |
| Fallback | Gemini 2.0 Flash | Free tier / $0.10/$0.40 |

### Recommended Model Assignment

| Agent | Model | Why | Cost (in/out per 1M) | Latency |
|-------|-------|-----|---------------------|---------|
| **Stimulus Agent** | **Gemini 2.0 Flash** (existing fallback) | Free tier covers monitoring volume. JSON mode. Already in tierManager. | $0.10/$0.40 (or free) | ~200ms |
| **Social Graph Agent** | **Groq Llama 3.1 8B** (existing classifier) | Entity extraction + relationship detection. Already proven in cognitive.ts. Cheapest. | $0.05/$0.08 | ~100ms |
| **Fusion Engine** | **No LLM — Deterministic scoring** | Production standard (Meta, Alexa, Google). Microsecond decisions. Zero cost. LLM only for edge cases. | $0 | <1ms |
| **Conversation Agent (simple)** | **Groq Llama 3.1 8B** | Currently routes all to 70B. Simple msgs (hi, ok, thanks) don't need 70B. | $0.05/$0.08 | ~100ms |
| **Conversation Agent (complex)** | **Groq Llama 3.3 70B** (existing) | Best personality quality in current stack. Keep as-is. | $0.59/$0.79 | ~400ms |
| **Tool Execution** | **Groq Llama 3.1 8B** (existing classifier) | Already handles tool routing + arg extraction via native function_calling at 0.1 temp. | $0.05/$0.08 | ~100ms |
| **Memory Extraction** | **Groq Llama 3.1 8B** (downgrade from 70B) | Currently uses 70B for fact/entity/relation extraction. 8B is sufficient for structured JSON extraction. Saves 10x. | $0.05/$0.08 | ~100ms |

### Why NOT switch to other models:
- **Claude Haiku/Sonnet**: 5-15x more expensive than Groq. Only justified for Bedrock signal extraction (already used there as fallback).
- **GPT-5 Mini**: Good function calling but adds vendor dependency. Groq 8B already handles this.
- **DeepSeek R1**: Overkill reasoning for this use case. Good for future complex planning tasks.
- **LangGraph**: The existing scheduler + task orchestrator already provides state machine capability. Adding LangGraph means rewriting the entire pipeline for marginal benefit.

### Cost Projection (1,000 users × 5 msgs/day)

| Component | Current Cost/month | After Optimization |
|-----------|-------------------|-------------------|
| Main 70B response (all msgs) | ~$150K | ~$60K (simple→8B, 60% are simple) |
| Memory extraction (4× 70B calls) | ~$45K | ~$5K (batch 1× 8B call) |
| Proactive agent (70B every 10m) | ~$30K | ~$0 (deterministic fusion) |
| Stimulus + Social agents | $0 | ~$3K (8B + Gemini Flash) |
| Other (reflection, signals, summaries) | ~$20K | ~$10K (skip unnecessary calls) |
| **Total** | **~$245K/month** | **~$78K/month (68% reduction)** |

---

## Work Units (10 units, dependency-ordered)

### WU1: Stimulus Agent — Continuous Environmental Monitor
**Priority: CRITICAL** | **Files: 4 new + 2 modified**

**New files:**
- `src/stimulus/stimulus-agent.ts` — Main agent loop: polls all stimulus sources, emits signals
- `src/stimulus/price-stimulus.ts` — Price drops as stimulus (extends broken `price-alerts.ts`)
- `src/stimulus/places-stimulus.ts` — Google Places proactive discovery (new openings, trending, currently quiet)
- `src/stimulus/types.ts` — Shared stimulus signal types

**Modified files:**
- `src/stimulus/stimulus-router.ts` — Refactor from "aggregate and sort" to "emit signals to fusion engine"
- `src/scheduler.ts` — Wire stimulus agent into cron cycle

**What changes:**
The stimulus agent runs every 10-30 min (via existing scheduler, NOT Kafka) and produces `StimulusSignal[]` per user:

```typescript
interface StimulusSignal {
  type: 'weather' | 'traffic' | 'price_drop' | 'new_place' | 'trending' | 'festival' | 'event';
  weight: number;        // 0-1, how significant
  data: Record<string, any>;  // weather state, price info, place details
  userId: string;
  timestamp: Date;
}
```

**Key additions:**
- `price-stimulus.ts`: FIX `price-alerts.ts` (currently detects drops but never notifies). Extend to food/grocery via existing `compare_food_prices` tool. Emit price_drop signals.
- `places-stimulus.ts`: Query Google Places API for user's home area — new openings (places with recent opening dates), trending spots (high recent reviews), currently quiet places (using existing `search_places` tool).
- Existing weather/traffic/festival stimuli continue working, just emit signals in new format.

**Model:** Gemini 2.0 Flash for any classification needed (already in tierManager fallback chain). Most stimulus detection is API-based (weather API, price comparison), not LLM-based.

**Reuse:** `src/weather/weather-stimulus.ts` (as-is), `src/stimulus/stimulus-router.ts` (refactor), `src/tools/places.ts` (for nearby queries), `src/alerts/price-alerts.ts` (fix and extend).

---

### WU2: Social Graph Agent — Continuous Conversation Tracker
**Priority: CRITICAL** | **Files: 3 new + 3 modified**

**New files:**
- `src/social/social-agent.ts` — Main agent: monitors all conversations, detects friend-relevant signals
- `src/social/social-signals.ts` — Types + signal extraction logic
- `src/stimulus/social-stimulus.ts` — Bridge: social signals → fusion engine format

**Modified files:**
- `src/graph-memory.ts` — Add `searchFriendsGraph(userId, query, limit)` cross-user query
- `src/social/friend-graph.ts` — Add `getFriendsExperiences(userId, entityName)` and `getActiveFriendTopics(userId)`
- `src/social/outbound-worker.ts` — Extend to handle fusion-driven outbound (not just PASSIVE→ACTIVE bridge)

**What changes:**
The social agent runs on two triggers:
1. **Per conversation turn** (fire-and-forget after response sent): Extract what this user is discussing, check if any friends have relevant experiences/interests
2. **Every 15 min** (via scheduler): Scan active topics across all users, detect correlated intents (2 friends both mentioning Goa)

Produces `SocialSignal[]`:

```typescript
interface SocialSignal {
  type: 'friend_reviewed' | 'friend_interested' | 'friend_nearby' | 'correlated_intent' | 'group_opportunity';
  userId: string;           // who this signal is FOR
  friendId: string;         // which friend triggered it
  friendName: string;
  data: {
    topic?: string;         // "Goa trip", "biryani", "Indiranagar cafes"
    entity?: string;        // "Meghana Foods", "Goa"
    friendOpinion?: string; // "Rohit said this place is overrated"
    confidence: number;     // 0-1
  };
}
```

**Cross-user graph query** (`graph-memory.ts`):
- `searchFriendsGraph(userId, query)`: Gets accepted friend IDs → searches their `entity_relations` for matching entities → returns annotated results ("Priya → VISITED → Meghana Foods, said: 'amazing biryani'")

**Friend activity detection** (`social-agent.ts`):
- After each conversation turn, check: does this user's current topic overlap with any friend's entity graph?
- Use existing `topic-intent` phase data + `entity_relations` to detect overlaps
- Use 8B (existing cognitive model) for entity extraction from conversation — same prompt pattern as `graph-memory.ts::extractEntities()`

**Model:** Groq Llama 3.1 8B for entity extraction (same model/prompt pattern as existing `graph-memory.ts`).

**Reuse:** `src/graph-memory.ts::extractEntities()`, `src/social/friend-graph.ts::getFriends()`, `src/topic-intent/index.ts::getActiveTopics()`, `src/social/outbound-worker.ts` (extend).

---

### WU3: Fusion Engine — Deterministic Proactive State Manager
**Priority: CRITICAL** | **Files: 3 new + 1 modified**

**New files:**
- `src/stimulus/fusion-engine.ts` — Combines all signals into scored proactive state per user
- `src/stimulus/proactive-state.ts` — Types + Redis-backed state store
- `src/utils/notification-budget.ts` — Per-user fatigue tracking

**Modified files:**
- `src/scheduler.ts` — Wire fusion engine into proactive cycle

**What changes:**

The Fusion Engine is **deterministic** (no LLM). It takes stimulus signals (WU1) + social signals (WU2) + user context and produces a **ProactiveState** per user, stored in Redis:

```typescript
interface ProactiveState {
  userId: string;
  updatedAt: Date;

  // Current environmental context
  weather: WeatherState | null;
  traffic: TrafficState | null;
  festival: FestivalState | null;

  // Active social insights (friends doing relevant things)
  socialInsights: SocialInsight[];  // "Rohit reviewed Meghana Foods", "Priya looking at Goa flights"

  // Pending proactive actions (scored, ready to fire)
  pendingActions: ScoredAction[];

  // Fatigue state
  messagesSentToday: number;
  lastMessageAt: Date | null;
  recentRejections: string[];      // categories rejected recently
}

interface ScoredAction {
  score: number;           // 0-1, must exceed 0.6 to fire
  type: 'suggest_delivery' | 'suggest_place' | 'friend_bridge' | 'trip_plan' | 'price_alert' | 'content';
  reason: string;          // human-readable: "raining + you love biryani + Meghana has a deal"
  stimuli: string[];       // which signals contributed
  friendsToMention: string[];
  toolToCall: string | null;
  suggestedMessage: string | null;  // hint for conversation agent
}
```

**Scoring formula** (deterministic, <1ms):
```
score = stimulusWeight × preferenceMatch × receptivity × (1 - fatigue)

Where:
- stimulusWeight: rain=0.7, price_drop=0.8, friend_active=0.6, festival=0.5, new_place=0.4, trending=0.3
- preferenceMatch: does this match user_preferences? (1.0 if match, 0.3 if neutral, 0.0 if rejected)
- receptivity: based on pulse engagement state (PROACTIVE=1.0, ENGAGED=0.8, CURIOUS=0.5, PASSIVE=0.3)
               × time factor (8am-10pm=1.0, else=0.2)
               × recency (last interaction <1h=0.9, <4h=0.7, <24h=0.5, >24h=0.3)
- fatigue: exponential decay based on messages sent today (0=1.0, 1=0.7, 2=0.4, 3+=0.1)
```

**Fatigue management** (production pattern):
- Max 3 proactive messages/day per user
- Min 1 hour between proactive messages
- Cross-stimulus dedup: if rain message sent, suppress traffic message for 30min (they correlate)
- Persistent rejection: if user rejects a category 3+ times, permanently lower its `preferenceMatch` to 0.0

**Why deterministic?** Production proactive systems (Alexa Hunches, Google Assistant, Meta notifications) NEVER use LLM for the "should I act?" decision. LLMs are too slow (seconds vs microseconds) and too expensive at scale. The LLM is only used to GENERATE the message after the decision is made.

**Reuse:** `src/pulse/pulse-service.ts::getState()` for engagement, `src/archivist/redis-cache.ts` for state storage, `src/intelligence/rejection-memory.ts` for rejection data.

---

### WU4: Conversation Agent — Proactive State Integration
**Priority: CRITICAL** | **Files: 0 new + 4 modified**

**Modified files:**
- `src/character/handler.ts` — Inject proactive state into conversation pipeline
- `src/personality.ts` — Add proactive state as new Layer 7e
- `src/media/proactiveRunner.ts` — Replace 70B "should I send?" with fusion engine score
- `src/brain/index.ts` — Inject social insights into tool reflection

**What changes:**

**A. Proactive State in Active Conversations** (`handler.ts` + `personality.ts`):
When user is actively chatting, the conversation agent reads the current `ProactiveState` from Redis and injects relevant insights into the system prompt:

New Layer 7e in `personality.ts`:
```
## What's Happening Right Now (Proactive Context)
- Weather: It just started raining in Koramangala
- Your friend Rohit recently said Meghana Foods biryani is "absolute fire"
- There's a 20% discount on Swiggy right now for your area
→ Weave these naturally into conversation when relevant. Don't force them.
```

This means even during ACTIVE conversation, Aria has ambient awareness: "btw Rohit mentioned that place is overrated" or "it's pouring right now, maybe order instead?"

**B. Proactive Outreach for Inactive Users** (`proactiveRunner.ts`):
Replace the current flow (70B LLM asks "should I send?" every 10 min) with:
1. Fusion Engine provides `pendingActions` with scores
2. If `score > 0.6` AND fatigue checks pass → generate message
3. Only THEN call 70B to compose the actual message using the action's `reason` + `friendsToMention` + SOUL.md
4. This eliminates ~60% of 70B proactive calls (the ones where answer was "no, don't send")

**C. Social Insights in Tool Results** (`brain/index.ts`):
When a tool like `search_places` or `search_zomato` returns results, also check `ProactiveState.socialInsights` for matching friend opinions. Append to tool reflection: "Also: your friend Priya visited this place and rated it 4/5."

**D. Autonomous Tool Initiation**:
When topic-intent reaches `executing` phase (confidence > 85%) AND proactive state has a matching `ScoredAction` with `toolToCall` → the conversation agent can proactively call tools without waiting for explicit user request. E.g., "I checked flights to Goa — ₹3.2K round trip on March 28. Priya is interested too. Want me to book?"

**Reuse:** `src/personality.ts::composeSystemPrompt()` (add layer), `src/character/handler.ts` (modify pipeline), `src/media/proactiveRunner.ts::run()` (replace gate logic).

---

### WU5: Trip Planning Proactive Flow
**Priority: HIGH** | **Files: 2 new + 2 modified**

**New files:**
- `src/proactive-intent/trip-funnel.ts` — Multi-step trip planning funnel with social integration
- `src/proactive-intent/trip-steps.ts` — Individual step definitions

**Modified files:**
- `src/proactive-intent/intent-selector.ts` — Add trip funnel selection when topic-intent reaches "shifting" on travel
- `src/topic-intent/index.ts` — Add trip-specific signal boosting

**What changes:**

**Trip Planning Funnel** (5 steps):
1. **Detect**: Topic-intent reaches "shifting" phase on travel category → trigger
2. **Enrich**: Query friends via social agent — "Priya also wants to visit Goa! Plan together?"
3. **Plan**: Call flight + hotel + places tools → draft itinerary with price comparison
4. **Confirm**: Present via inline buttons (Accept / Modify / Add Friend / Dismiss)
5. **Execute**: Provide booking links (or TON payment if WU8 is done)

**Social integration**:
- When `detectCorrelatedIntents()` finds 2+ friends mentioning same destination → auto-trigger group trip funnel
- When one friend books → notify squad: "Priya booked Goa flights for March 28"

**Reuse:** `src/proactive-intent/orchestrator.ts` (existing funnel infrastructure), `src/social/squad.ts` (existing squad system), `src/tools/travel-mcp.ts` (flights/hotels).

---

### WU6: LLM Pipeline Cost Optimization
**Priority: HIGH** | **Files: 0 new + 5 modified**

**Modified files:**
- `src/character/handler.ts` — Route simple messages to 8B response instead of 70B
- `src/memory-store.ts` — Batch 2 extraction calls into 1, downgrade to 8B
- `src/graph-memory.ts` — Batch 3 extraction calls into 1, downgrade to 8B
- `src/scout/reflection.ts` — Skip reflection for data-rich results (>500 chars)
- `src/intelligence/rejection-memory.ts` — Regex pre-filter before Bedrock call

**What changes:**

**A. 8B for simple messages** (`handler.ts`):
- Current: classifier returns `complexity: 'simple'` but response still uses 70B
- Change: If `simple`, use Tier 1 (8B) for response generation with compact system prompt (Layer 1 + 2 only)
- Saves ~6,000 tokens per simple message. ~60% of messages are simple.

**B. Batched memory extraction** (`memory-store.ts` + `graph-memory.ts`):
- Current: 5 separate LLM calls per non-simple message (extractFacts, extractEntities, extractRelations, detectContradictions, decideMemoryActions)
- Change: Single 8B call with multi-task JSON prompt:
```json
{
  "facts": [...],
  "entities": [...],
  "relations": [...],
  "contradictions": [...],
  "memory_actions": [...]
}
```
- Downgrade from 70B to 8B (sufficient for structured extraction at temp 0.1)
- Saves ~1,400 tokens + 4 LLM round-trips per message

**C. Skip scout reflection** (`reflection.ts`):
- If tool returned >500 chars of structured data, skip 8B reflection (data is likely good)
- Only reflect on sparse/error results

**D. Regex pre-filter for rejection extraction** (`rejection-memory.ts`):
- Before calling Bedrock/8B, check for rejection keywords ("no", "hate", "don't", "not interested")
- Skip LLM call if no rejection language detected (~90% of messages)

---

### WU7: Agentic Browser Automation
**Priority: MEDIUM** | **Files: 1 new + 2 modified**

**New files:**
- `src/browser-agent.ts` — AgenticBrowser class wrapping existing Playwright

**Modified files:**
- `src/tools/index.ts` — Register `browser_action` tool
- `src/scout/cache.ts` — Add TTL for browser results

**What changes:**
- Build on existing `src/browser.ts` (Playwright Extra + Stealth + SSRF protection)
- Add `extractPageActions(page)` → find interactable elements
- Add `executeAction(page, action)` → click, type, select, scroll
- Add `runAgenticFlow(url, goal, maxSteps)` → multi-step with 8B action decisions
- Use existing 8B classifier for action decisions (NOT a separate model)

**Reuse:** `src/browser.ts` (all existing infra — stealth, SSRF, UA rotation).

---

### WU8: TON Blockchain Integration
**Priority: MEDIUM** | **Files: 1 new + 3 modified**

**New files:**
- `src/tools/ton-mcp.ts` — MCP client for TON payments

**Modified files:**
- `src/tools/mcp-client.ts` — Add TON server config
- `src/tools/index.ts` — Register payment tools
- `src/task-orchestrator/` — Add payment_flow workflow

**What changes:**
Follow existing Swiggy/Zomato MCP pattern exactly. Wire into trip funnel (WU5) for booking payments.

**Reuse:** `src/tools/mcp-client.ts::callMCPTool()` (existing transport layer).

---

### WU9: Redis Cache Consistency
**Priority: MEDIUM** | **Files: 1 new + 5 modified**

**New files:**
- `src/utils/cache.ts` — Generic `withCache<T>(key, ttl, fetcher)` helper

**Modified files:**
- `src/scout/cache.ts` — Use shared Redis client from `archivist/redis-client.ts`
- `src/graph-memory.ts` — Cache `searchGraph()` (5min TTL)
- `src/pulse/pulse-service.ts` — Cache `getState()` (60s TTL)
- `src/stimulus/stimulus-router.ts` — Cache `getUserHomeLocation()` (1h TTL)
- `src/social/friend-graph.ts` — Cache `getFriends()` (5min TTL)

**Reuse:** `src/archivist/redis-client.ts::getRedis()` (unify with scout's separate client).

---

### WU10: MCP Standardization
**Priority: LOW** | **Files: 2 modified**

Check if Blinkit/Zepto publish official MCP servers. If yes, add configs. If no, skip.

---

## Dependency Graph & Execution Order

```
Phase 1 (parallel, no dependencies):
├── WU1: Stimulus Agent
├── WU2: Social Graph Agent
├── WU9: Redis Cache Consistency
└── WU7: Agentic Browser

Phase 2 (depends on WU1 + WU2):
├── WU3: Fusion Engine (consumes signals from WU1 + WU2)
└── WU6: LLM Cost Optimization (independent but logically grouped)

Phase 3 (depends on WU3):
├── WU4: Conversation Agent integration (reads proactive state from WU3)
└── WU5: Trip Planning Funnel (uses social data from WU2 + fusion from WU3)

Phase 4 (independent, lower priority):
├── WU8: TON Integration
└── WU10: MCP Standardization
```

---

## How It All Works Together — End-to-End Example

### Scenario: "It's raining, user loves biryani, friend reviewed Meghana Foods"

**Background (continuous):**
1. **Stimulus Agent** detects: RAIN_START in Koramangala (via OpenWeatherMap)
2. **Stimulus Agent** detects: Meghana Foods has 15% off on Swiggy (via price monitoring)
3. **Social Graph Agent** detects: Friend Rohit's entity graph has `Rohit → REVIEWED → Meghana Foods, opinion: "best biryani in Bangalore"`
4. **Fusion Engine** combines:
   - rain (weight 0.7) + user prefers biryani (preferenceMatch 1.0) + friend reviewed relevant place (socialWeight 0.6) + price drop (weight 0.8)
   - User is ENGAGED (receptivity 0.8), last active 2h ago (recency 0.7), 0 messages today (fatigue 1.0)
   - **Score: 0.78** (above 0.6 threshold)
   - Creates `ScoredAction`: type=suggest_delivery, reason="raining + biryani preference + Rohit recommends Meghana + 15% off", friendsToMention=["Rohit"]

**If user is INACTIVE:**
5. **Conversation Agent** reads `ProactiveState.pendingActions[0]`
6. Calls 70B with SOUL.md + proactive context → generates: "Machha it's pouring — Meghana's got 15% off rn and Rohit swears their biryani is unmatched. Just saying 👀"
7. Sends via Telegram

**If user is ACTIVE (chatting about dinner plans):**
5. **Conversation Agent** has `ProactiveState` injected as Layer 7e
6. During conversation, 70B naturally weaves in: "oh wait it's raining rn — Meghana's has a deal and Rohit literally won't shut up about their biryani. Order?"

### Scenario: "Two friends independently mention Goa"

1. **Social Graph Agent** processes Friend A's conversation: topic-intent detects "Goa trip" at "probing" phase
2. **Social Graph Agent** processes Friend B's conversation: topic-intent detects "beaches" + "Goa" at "noticed" phase
3. `detectCorrelatedIntents()` finds overlap → emits `correlated_intent` social signal
4. **Fusion Engine** creates `ScoredAction` for both users: type=trip_plan, friendsToMention=[other friend]
5. **Conversation Agent** (for User A): "Wait — Priya was also looking at Goa stuff. Want me to check flights for both of you?"
6. If accepted → Trip Planning Funnel (WU5) activates: searches flights, hotels, creates shared itinerary

---

## E2E Verification Per Work Unit

| WU | Test |
|----|------|
| WU1 | Mock rain API response → verify `StimulusSignal` emitted with type='weather', weight=0.7 |
| WU2 | Create 2 users as friends, User A has entity "Meghana Foods" → query `searchFriendsGraph(UserB, "Meghana")` → verify returns User A's relation |
| WU3 | Feed rain signal + friend signal + user prefs → verify `ScoredAction` with score > 0.6. Feed 3 messages today → verify fatigue blocks action. |
| WU4 | Set proactive state with social insight → send message → verify Layer 7e appears in system prompt. Set user inactive + pending action → verify proactive message sent. |
| WU5 | Set topic-intent to "shifting" for travel → verify trip funnel triggered. Create correlated intent between friends → verify group plan suggested. |
| WU6 | Send "hi" → verify 8B used (not 70B). Send complex msg → verify single batched extraction call. |
| WU7 | Run `browser_action` against test form page → verify fields filled + screenshot captured |
| WU8 | Create payment request → verify task orchestrator state transitions |
| WU9 | Run handler twice with same user → verify Redis cache hit on second call for graph/pulse/friends |
| WU10 | Check Blinkit/Zepto MCP availability → integrate or skip |

---

## What We're NOT Doing (and Why)

| Rejected Approach | Why |
|---|---|
| LangGraph for orchestration | Task orchestrator + scheduler already provide state machines. LangGraph = full rewrite. |
| Kafka/Redis Streams | Cron scheduler handles current scale. Kafka is for >10K users/sec. |
| Neo4j/Neptune | PostgreSQL + pgvector + recursive CTEs is sufficient and already working. |
| Separate Claude Haiku tier for tools | 8B handles tool routing at ~100ms. Haiku adds cost + vendor dependency. |
| Containerized MCP for all tools | Only valuable for platforms with official MCP servers (Swiggy, Zomato). |
| 4-model MoA system | 2-model (8B + 70B) with smart routing is optimal for cost/quality. |
