# Gap Analysis: Personifi/Aria vs Output-First Agent Vision

**Analysis Date:** 2026-03-17
**Compared Against:** NemoClaw (NVIDIA), Nanobot (HKUDS), Vision Spec

---

## GAP 1: Proactive / Output-First Trigger System

### What's Missing
The agent should be **always-on, always observing** — initiating conversations without user input when conditions align. Currently, proactive behavior is a collection of independent cron jobs, not a unified trigger system.

### Current State in Personifi
- `src/scheduler.ts`: 12+ independent cron jobs running on fixed schedules
- `src/stimulus/stimulus-router.ts`: Aggregates weather/traffic/festival into `StimulusAction[]` with priority ranking
- `src/proactive/proactiveRunner.ts`: Generates content for inactive users (content blast every 2h)
- Topic follow-ups run every 30 min for warm topics

**What works:** Stimulus aggregation exists and priority ranking is solid (1-8 scale).
**What doesn't:** Cron jobs are disconnected — stimulus results don't feed into a unified decision engine. The system sends content on schedule, not when conditions align.

### Relevant Nanobot Pattern
- `nanobot/heartbeat/service.py` (lines 40-100): Two-phase pattern — external trigger → LLM decision → conditional action
- `nanobot/cron/service.py` (lines 63-150): General-purpose scheduler with `at`, `every`, `cron` trigger types

**Nanobot's heartbeat pattern** is the right abstraction: periodic wake-up → evaluate all signals → decide whether to act. But nanobot doesn't combine multiple signal sources.

### Recommended Implementation
Build an **Agent Tick Loop** that runs every N minutes (configurable per user):

```
tick(userId):
  stimuli = getPersonalizedStimuli(userId)      # weather, traffic, festival
  pendingIntents = getPendingIntents(userId)     # from conversation extraction
  socialSignals = getSocialSignals(userId)       # friend activity, group plans
  userState = getUserState(userId)               # last active, current context

  score = fusionRank(stimuli, pendingIntents, socialSignals, userState)

  if score.shouldAct:
    message = preReasoningBuffer(score, userId)
    send(userId, message)
```

**Where to build:** New file `src/agent/tick-loop.ts`. Replace all proactive cron jobs with a single tick scheduler. Keep stimulus-router as a data source, not a trigger.

---

## GAP 2: Fusion Ranking Engine (Multi-Stimuli Scoring)

### What's Missing
All stimuli should combine into a **Proactive State Score per user**. When the score crosses a threshold for a trigger type (social event, weather window, deal, new place), the agent initiates.

### Current State in Personifi
- `src/stimulus/stimulus-router.ts`: Priority-ranks individual stimuli (1-8 scale) but does **not combine them** into a composite score
- `src/intelligence-cron.ts`: Updates affinity scores per user preference category, but these don't feed into proactive triggers
- `database/migrations/002-proactive-agent-schema.sql`: `user_preferences.affinity_score` exists (0.000-1.000) but unused for trigger decisions

**Missing:** No composite scoring. A rainy evening + user mentioned wanting biryani + friend is nearby = high-score trigger. Currently these are three independent signals that never meet.

### Relevant Patterns
- **NemoClaw:** None (no reasoning/scoring layer)
- **Nanobot:** None (no multi-signal fusion)
- **Must build from scratch.**

### Recommended Implementation
New module `src/agent/fusion-engine.ts`:

```typescript
interface ProactiveScore {
  userId: string
  totalScore: number           // 0.0 - 1.0 composite
  triggerType: TriggerType     // 'social_event' | 'weather_window' | 'deal' | 'new_place' | 'friend_activity'
  stimuliContributions: {
    environmental: number      // weather + traffic + festival
    conversational: number     // pending intents + interest signals
    social: number             // friend activity + compatibility
    temporal: number           // time of day + day of week + user activity pattern
  }
  shouldAct: boolean           // totalScore > threshold[triggerType]
  confidence: number
  suggestedMessageType: string
}
```

**Scoring formula (weighted):**
- Environmental stimuli: 25% weight (from stimulus-router)
- Conversation signals: 30% weight (pending intents, detected topics with positive interest)
- Social graph: 25% weight (friend activity, compatibility score)
- Temporal context: 20% weight (user's typical active hours, last message time)

**Thresholds per trigger type:**
- Social event: 0.65 (lower — social is inherently high value)
- Weather window: 0.70
- Deal/sale: 0.75 (avoid being spammy with deals)
- New place: 0.80 (high bar — only when strong preference match)

**DB table:** `proactive_scores` — userId, score breakdown, timestamp, acted_on boolean

---

## GAP 3: Pre-Reasoning Buffer / Rolling Time-Window Context

### What's Missing
Before any message is sent, the agent should run a pre-reasoning pass: combine current stimuli + pending intents from past conversations + decide message type, tone, timing. This same buffer enriches active conversations.

### Current State in Personifi
- `src/cognitive.ts`: Extracts `cognitiveState` per message (internalMonologue, emotionalState, conversationGoal) but this is **per-turn, not rolling**
- `src/cognitive.ts` line `updateConversationGoal()`: Persists goals to `conversation_goals` table — but goals are overwritten, not accumulated
- No rolling time-window context aggregation exists

### Relevant Nanobot Pattern
- `nanobot/agent/memory.py` — `MemoryConsolidator`: Maintains rolling context by consolidating old messages when token budget exceeded
- `nanobot/agent/context.py`: `ContextBuilder.build_messages()` assembles context from multiple sources (bootstrap files, memory, session history)

**Nanobot's consolidation pattern** is relevant but needs to be adapted from "compress old messages" to "accumulate signals over time."

### Recommended Implementation
New module `src/agent/pre-reasoning-buffer.ts`:

```typescript
interface TimeWindowContext {
  userId: string
  windowStart: Date           // rolling 24h or configurable
  windowEnd: Date
  pendingIntents: Intent[]    // extracted from recent conversations
  recentStimuli: StimulusAction[]  // last N stimulus snapshots
  socialUpdates: SocialEvent[]     // friend activity in window
  conversationSignals: {
    lastTopic: string
    interestLevel: 'positive' | 'negative' | 'neutral'
    mentionedEntities: string[]
    unfulfilledRequests: string[]
  }
}

async function preReason(userId: string): Promise<PreReasoningResult> {
  const window = await buildTimeWindow(userId, hours=24)
  const score = fusionRank(window)

  if (score.shouldAct) {
    return {
      action: 'initiate',
      messageType: score.triggerType,
      tone: selectToneFromContext(window),
      timing: calculateOptimalTiming(window),
      content_hints: buildContentHints(window)
    }
  }
  return { action: 'wait' }
}
```

**Where to store:** `pending_intents` table — userId, intent_text, source_message_id, extracted_at, status (pending/acted/expired), expires_at

---

## GAP 4: Social Graph — Current vs Required

### What's Missing
The vision requires the agent to behave like a mutual friend who knows everyone in the circle: compatibility scores, cross-user preference aggregation, cross-user activity coordination.

### Current State in Personifi
- `src/graph-memory.ts`: Entity-relationship graph with entities (person, place, food, etc.) and relationships (prefers, visited, etc.)
- `database/vector.sql`: `entity_relations` table with confidence scoring
- `database/identity.sql`: Cross-channel identity linking (`persons` table)

**What exists:** User-to-entity relationships. "User prefers biryani." "User visited Bali."
**What's missing:**
- **User-to-user relationships** — No friendship edges, no compatibility scores
- **Cross-user queries** — Can't ask "what do User A and User B both like?"
- **Group membership** — No concept of social circles
- **Friend activity tracking** — No way to know what friends are doing
- **Cross-user coordination** — Can't broadcast plans across a friend group

### Relevant Patterns
- **NemoClaw:** None
- **Nanobot:** None (single-user only)
- **Must build from scratch.**

### Recommended Implementation
Extend the social graph schema:

```sql
-- User-to-user relationships
CREATE TABLE user_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_a UUID REFERENCES users(user_id),
    user_b UUID REFERENCES users(user_id),
    relationship_type VARCHAR(50),  -- 'friend', 'close_friend', 'acquaintance', 'family'
    compatibility_score DECIMAL(3,2) DEFAULT 0.50,
    shared_interests TEXT[],
    interaction_count INTEGER DEFAULT 0,
    last_interaction TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_a, user_b)
);

-- Social circles / groups
CREATE TABLE social_circles (
    circle_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200),
    created_by UUID REFERENCES users(user_id),
    members UUID[],
    circle_type VARCHAR(50),  -- 'college', 'work', 'family', 'hobby'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Friend activity feed (what friends mentioned doing)
CREATE TABLE friend_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id),
    activity_type VARCHAR(100),  -- 'going_out', 'planning_trip', 'mentioned_place', 'shared_deal'
    details JSONB,
    mentioned_entities TEXT[],
    extracted_from_message_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);
```

**Compatibility score algorithm:**
- Start at 0.50
- +0.05 per shared preference (same cuisine, similar budget range, overlapping travel interests)
- +0.03 per positive interaction mention ("went out with X", "X recommended Y")
- -0.05 per conflict signal
- Cap at 0.99
- Updated by intelligence cron (already runs every 2h)

---

## GAP 5: Real-Time Data Pipeline → Proactive Agent State Wiring

### What's Missing
Currently, data fetching (Google Places, OpenWeather, scrapers) is reactive — triggered by user messages. The vision requires data to **continuously flow into the agent's proactive state**, enabling triggers like "new coffee shop opened near user's college."

### Current State in Personifi
- `src/stimulus/stimulus-router.ts`: Refreshes weather/traffic/festival every 30 min — this IS proactive data, but limited to 3 types
- `src/tools/places.ts`: Google Places fetched **only on user query**
- `src/tools/scrapers/*.ts`: All scrapers triggered **only on user query**
- No background polling for new places, deals, or restaurant data

### Recommended Implementation
New module `src/agent/data-pipeline.ts`:

```typescript
// Background data refresh per active user
async function refreshUserDataSources(userId: string) {
  const location = await getUserLocation(userId)
  const preferences = await getUserPreferences(userId)

  // Parallel refresh
  await Promise.allSettled([
    refreshNearbyPlaces(location, preferences),  // new places, trending spots
    refreshFoodDeals(location, preferences),      // Zomato/Swiggy deals matching preferences
    refreshWeather(location),                      // already exists in stimulus-router
    refreshTrafficState(location),                 // already exists
  ])
}

// Run every 30 min for active users (merge with stimulus refresh)
```

**Key change:** Move from "fetch on demand" to "fetch in background, serve from cache."

---

## GAP 6: Data Access Layer Failures

### What's Missing
Reliable, always-accurate data from Zomato, Swiggy, Ola, Uber, Rapido. Current implementations are fragile scrapers that break on API changes.

### Current State (Detailed Failure Map)

| Service | File | Primary Failure | Root Cause |
|---------|------|-----------------|------------|
| **Zomato** | `src/tools/scrapers/zomato.ts` | 401 on direct API | Region-specific auth requirements; `x-zomato-app` header may be deprecated |
| **Swiggy** | `src/tools/scrapers/swiggy.ts` | Device blocking after ~50 requests | Device ID pool of only 5; Swiggy fingerprints beyond just device ID |
| **Ola** | `src/tools/ride-compare.ts` | No live data at all | Hardcoded rate cards; estimates can be 20-40% off |
| **Uber** | `src/tools/ride-compare.ts` | No live data at all | Hardcoded rate cards; no surge detection |
| **Rapido** | `src/tools/ride-compare.ts` | No live data at all | Hardcoded rate cards |
| **Blinkit** | `src/tools/scrapers/blinkit.ts` | ~30% failure rate | JS-heavy rendering; XHR patterns change frequently |
| **Zepto** | `src/tools/scrapers/zepto.ts` | Playwright timeouts | Heavy JS rendering; SerpAPI fallback costs $5/1000 |

### Recommended Approach
See GAP 8 (Real Account Simulation) and Phase 6 recommendations for per-app strategy.

---

## GAP 7: Background Cache Worker — Continuous Data Freshness

### What's Missing
A background worker that continuously scrapes/fetches data for active users, stored with freshness timestamps, with per-app TTL.

### Current State in Personifi
- Each scraper has its own in-memory cache (10-30 min TTL)
- `src/archivist/redis-cache.ts`: Redis caching exists but used mainly for sessions/embeddings
- No unified cache layer with freshness tracking
- No background worker that pre-fetches data

### Recommended Implementation

```sql
CREATE TABLE data_cache (
    cache_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service VARCHAR(50),        -- 'zomato', 'swiggy', 'ola', 'uber', 'google_places'
    query_key VARCHAR(500),     -- normalized query (location + search term)
    data JSONB,
    fetched_at TIMESTAMPTZ DEFAULT NOW(),
    ttl_seconds INTEGER,        -- per-app TTL
    fetch_method VARCHAR(50),   -- 'direct_api', 'mcp', 'playwright', 'rate_card'
    is_stale BOOLEAN DEFAULT FALSE,
    user_context JSONB,         -- location, preferences that influenced results
    UNIQUE(service, query_key)
);

CREATE INDEX idx_cache_freshness ON data_cache(service, fetched_at);
```

**Per-app TTL:**
| Service | TTL | Rationale |
|---------|-----|-----------|
| Ride prices (Ola/Uber/Rapido) | 5 min | Prices change with surge |
| Food delivery (Zomato/Swiggy) | 2 hours | Restaurant availability, menus |
| Grocery (Blinkit/Zepto/Instamart) | 1 hour | Stock changes less frequently |
| Weather | 15 min | Already exists |
| Google Places | 6 hours | Place listings rarely change |
| Traffic | 10 min | Highly dynamic |

**Background worker:** `src/agent/cache-worker.ts`
- Runs every 5 min
- Queries `data_cache` for entries approaching TTL
- Pre-fetches data for active users' most-used queries
- Updates cache with new data + timestamp

---

## GAP 8: Real Account Simulation Layer

### What's Missing
Bot's own registered accounts on Zomato, Swiggy, Ola, Uber, Rapido — used when cache is stale or scraper fails. Simulates a real user opening the app via Playwright.

### Current State in Personifi
- All scrapers run as anonymous users (no logged-in sessions)
- Swiggy scraper uses spoofed device IDs (5-device pool) but no real account
- Zomato direct API uses `x-zomato-app` header but no auth cookies
- MCP integrations (Swiggy/Zomato) use OAuth tokens but these are **developer API tokens**, not consumer accounts

### Recommended Implementation

```
src/agent/accounts/
  ├── account-manager.ts     -- Manages bot's accounts across services
  ├── session-manager.ts     -- Maintains logged-in Playwright sessions
  ├── otp-handler.ts         -- Handles OTP via e-SIM API
  ├── providers/
  │   ├── zomato-account.ts  -- Zomato login flow
  │   ├── swiggy-account.ts  -- Swiggy login flow
  │   ├── ola-account.ts     -- Ola login flow
  │   ├── uber-account.ts    -- Uber login flow
  │   └── rapido-account.ts  -- Rapido login flow
  └── cookie-store.ts        -- Persistent cookie storage (encrypted)
```

**Decision logic (implement in `src/agent/data-resolver.ts`):**
```typescript
async function resolveData(service: string, query: string, userId: string) {
  // 1. Check cache
  const cached = await getCachedData(service, query)
  if (cached && !isStale(cached)) return cached.data

  // 2. Try MCP (if available)
  if (hasMCP(service)) {
    const mcpResult = await tryMCP(service, query)
    if (mcpResult.success) { updateCache(service, query, mcpResult.data); return mcpResult.data }
  }

  // 3. Try real account fetch
  const accountResult = await tryAccountFetch(service, query)
  if (accountResult.success) { updateCache(service, query, accountResult.data); return accountResult.data }

  // 4. Try anonymous scraper
  const scraperResult = await tryScraper(service, query)
  if (scraperResult.success) { updateCache(service, query, scraperResult.data); return scraperResult.data }

  // 5. Return stale cache + flag
  if (cached) return { ...cached.data, _stale: true, _staleSince: cached.fetched_at }

  return null
}
```

---

## GAP 9: E-SIM Integration

### What's Missing
The bot's own phone number for OTP verification, account registration, and session management on consumer apps.

### Current State in Personifi
- Zero e-SIM or phone number infrastructure
- No OTP handling capability

### Recommended Implementation

**Option A: Virtual Number API (Recommended to start)**
- Services: Textlocal, MSG91, or Twilio (India numbers)
- Cost: ~₹200-500/month for a dedicated Indian mobile number
- Receive OTP via webhook → parse → inject into Playwright flow

**Option B: Physical e-SIM with API Bridge**
- eSIM from Airtel/Jio loaded in a dedicated device or eSIM manager
- SMS forwarding to webhook endpoint
- More reliable (real carrier number) but higher maintenance

```typescript
// src/agent/accounts/otp-handler.ts
interface OTPHandler {
  requestOTP(service: string, phoneNumber: string): Promise<void>
  waitForOTP(phoneNumber: string, timeout: number): Promise<string>
  getPhoneNumber(): string
}

class VirtualNumberOTPHandler implements OTPHandler {
  private webhookUrl: string
  private pendingOTPs: Map<string, Promise<string>>

  async waitForOTP(phone: string, timeout = 60000): Promise<string> {
    // Listen on webhook for incoming SMS matching OTP pattern
    // Return extracted 4-6 digit code
  }
}
```

**Database:**
```sql
CREATE TABLE bot_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service VARCHAR(50),           -- 'zomato', 'swiggy', 'ola', 'uber', 'rapido'
    phone_number VARCHAR(15),
    account_status VARCHAR(20),    -- 'active', 'suspended', 'otp_pending', 'needs_reverification'
    cookies_encrypted TEXT,
    session_token TEXT,
    last_login TIMESTAMPTZ,
    last_otp_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## GAP 10: Conversation Context Extraction for Pending Intents

### What's Missing
When a user mentions wanting to try something, go somewhere, or ask about someone — these signals should persist as **pending intents** and get acted on when stimuli align.

### Current State in Personifi
- `src/cognitive.ts`: Extracts `detected_topic` and `interest_signal` per message, but these are **consumed and discarded** — not persisted for future use
- `conversation_goals` table: Persists current goal per session, but goals are overwritten (not accumulated)
- No concept of "pending intents" that survive across sessions

### Relevant Nanobot Pattern
- `nanobot/agent/memory.py`: Long-term memory in `MEMORY.md` persists facts across sessions
- `nanobot/heartbeat/service.py`: `HEARTBEAT.md` serves as a "pending tasks" file that the agent reads on wake-up

### Recommended Implementation

```sql
CREATE TABLE pending_intents (
    intent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id),
    intent_type VARCHAR(50),          -- 'try_place', 'go_somewhere', 'ask_about_person', 'buy_something', 'plan_trip'
    intent_text TEXT,                  -- "want to try that new ramen place"
    extracted_entities TEXT[],         -- ['ramen', 'new place']
    source_message_id TEXT,
    confidence DECIMAL(3,2),
    status VARCHAR(20) DEFAULT 'pending',  -- 'pending', 'acted', 'expired', 'user_cancelled'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '7 days',
    acted_at TIMESTAMPTZ
);
```

**Extraction:** Extend `cognitive.ts` classifier to output `pending_intent` field when interest_signal is 'positive' or 'committed'. Persist to DB immediately after classification.

**Consumption:** Tick loop reads pending intents → checks if any stimuli match → fires proactive message.

---

## GAP 11: Multi-User Coordination

### What's Missing
Broadcasting and cross-graph event propagation: "If User B is planning something, agent tells User A."

### Current State in Personifi
- `src/social/`: Friend bridge outbound exists (*/30 min cron) but is one-way content distribution
- No mechanism to detect "User B is planning a trip" and notify User A
- No group plan coordination

### Recommended Implementation

```typescript
// src/agent/social-coordinator.ts

async function detectAndBroadcast(userId: string, message: string, extractedIntent: Intent) {
  // 1. Check if intent is shareable (going out, planning trip, found a deal)
  if (!isSharableIntent(extractedIntent)) return

  // 2. Find compatible friends
  const friends = await getCompatibleFriends(userId, extractedIntent)

  // 3. For each friend: check if they'd be interested (preference match + availability)
  for (const friend of friends) {
    const relevance = await scoreRelevance(friend, extractedIntent)
    if (relevance > 0.6) {
      await queueSocialMessage(friend.userId, {
        type: 'friend_activity',
        from: userId,
        intent: extractedIntent,
        tone: 'casual_mention'  // "btw, {name} mentioned trying that new place in Koramangala"
      })
    }
  }
}
```

**Where to hook:** After `classifyMessage()` in `handler.ts`, if `detected_topic` + `interest_signal === 'committed'`, call `detectAndBroadcast()`.

---

## GAP 12: Agent Lifecycle — Continuous Tick Loop

### What's Missing
The vision requires a **continuous tick loop** (the agent is "always running"). Currently, the agent is request-response with bolted-on cron jobs.

### Current State in Personifi
- `src/index.ts`: Fastify HTTP server — purely request-response
- `src/scheduler.ts`: node-cron jobs — timer-based, not event-driven
- No concept of an agent "tick" or continuous evaluation loop

### Relevant Nanobot Pattern
- `nanobot/agent/loop.py`: `AgentLoop.run()` — consumes from message bus in a continuous loop with 1.0s timeout
- `nanobot/heartbeat/service.py`: Periodic wake-up mechanism

### Recommended Implementation
Don't replace the HTTP server. Add a **parallel event loop** alongside it:

```typescript
// src/agent/agent-loop.ts

class AgentLoop {
  private tickInterval: number = 5 * 60 * 1000  // 5 min default
  private running: boolean = false

  async start() {
    this.running = true
    while (this.running) {
      const activeUsers = await getActiveUsers()

      for (const user of activeUsers) {
        await this.tick(user.userId)
      }

      await sleep(this.tickInterval)
    }
  }

  async tick(userId: string) {
    // 1. Refresh data sources (if stale)
    await refreshUserDataSources(userId)

    // 2. Build time-window context
    const context = await buildTimeWindow(userId)

    // 3. Fusion score
    const score = await fusionRank(context)

    // 4. Pre-reason and maybe act
    if (score.shouldAct) {
      const message = await preReason(userId, score)
      await sendProactiveMessage(userId, message)
    }
  }
}
```

**Where to start:** `src/index.ts` — after Fastify server starts, also start `AgentLoop.start()` as a parallel process.

---

## GAP 13: Cache Decision Logic

### What's Missing
Unified decision logic: when to serve cache vs trigger real account vs scraper fallback.

### Current State in Personifi
- Each scraper implements its own retry/fallback independently
- No shared decision framework
- No "stale data is better than no data" pattern (scrapers return empty on failure)

### Recommended Implementation

```typescript
// src/agent/data-resolver.ts

const RESOLUTION_STRATEGY = {
  zomato:  ['cache', 'mcp', 'direct_api', 'account_fetch', 'playwright_ssr', 'playwright_xhr', 'dom_fallback', 'stale_cache'],
  swiggy:  ['cache', 'mcp', 'direct_api', 'account_fetch', 'playwright_mobile', 'dom_fallback', 'stale_cache'],
  ola:     ['cache', 'account_fetch', 'rate_card_estimate'],
  uber:    ['cache', 'account_fetch', 'rate_card_estimate'],
  rapido:  ['cache', 'account_fetch', 'rate_card_estimate'],
  places:  ['cache', 'google_api', 'stale_cache'],
  weather: ['cache', 'openweather_api', 'stale_cache'],
}

async function resolve(service: string, query: string): Promise<DataResult> {
  const strategy = RESOLUTION_STRATEGY[service]

  for (const method of strategy) {
    const result = await tryMethod(method, service, query)
    if (result.success) {
      if (method !== 'cache' && method !== 'stale_cache') {
        await updateCache(service, query, result.data, method)
      }
      return { ...result, method, isFresh: method !== 'stale_cache' }
    }
  }

  return { success: false, data: null, method: 'none' }
}
```

This replaces the scattered try/catch chains in each scraper with a unified, configurable resolution pipeline.
