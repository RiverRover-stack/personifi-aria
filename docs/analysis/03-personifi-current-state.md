# Personifi/Aria Current State + Data Access Failure Map

**Repo:** personifi-aria (local)
**Analysis Date:** 2026-03-17

---

## Bot Core: Purely Reactive + Scheduled Proactive

The agent is fundamentally reactive — it processes incoming messages through a dual-LLM pipeline. Proactive behavior is bolted on via 12+ scheduled cron jobs.

### Message Processing Flow (End-to-End)

```
Webhook (Telegram/WhatsApp/Slack)
  → index.ts (line 213-413)
    → Early command handling (buttons, emoji reactions, GPS shares)
    → Location extraction + reverse geocoding
    → Placeholder dispatch (typing indicator)
    → classifyMessage() [Groq 8B, ~50-150ms]
      → Fast-path regex for obvious simple messages
      → Returns: {complexity, needs_tool, tool_hint, tool_args, cognitiveState}
    → Conditional pipeline:
      - Simple: skip memory, graph, cognitive
      - Moderate/Complex: parallel Promise.all([memory, graph, cognitive])
    → If needs_tool: BodyHooks.executeTool()
    → tierManager.generateResponse() [Groq 70B, ~400ms]
    → Post-processing: store memory, update session, filter output
    → Send response with inline keyboards/buttons
```

**Ref:** `src/index.ts`, `src/character/handler.ts`, `src/cognitive.ts`, `src/llm/tierManager.ts`

---

## Persona: Single Character — Aria

There is **one character only**. No Atlas, Foody, or Cinemax exist in the codebase.

**Personality defined in:** `config/SOUL.md` (314 lines)
- "The friend people text before stepping out"
- 2-3 sentences max per reply
- Personality: 30% witty, 25% helpful, 25% opinionated, 20% mirror
- Mirrors user energy (formal ↔ casual)
- Cultural context awareness (learns subtly, never stereotypes)

---

## Brain & Soul: Dual-LLM Pipeline

| Model | Role | Provider | Latency | Cost |
|-------|------|----------|---------|------|
| **Groq 8B** (llama-3.1-8b-instant) | Classification + tool routing + cognitive extraction | Groq | ~50-150ms | ~Free tier |
| **Groq 70B** (llama-3.3-70b) | Personality-infused response generation | Groq | ~400ms | $0.59/$0.79 per 1M tokens |
| **Gemini Flash 2.0 / 1.5** | Fallback for 70B | Google | ~500ms | Pay-per-use |

**8B outputs:** `ClassifierResult` — complexity, needs_tool, tool_hint/args, cognitiveState (internalMonologue, emotionalState, conversationGoal, relevantMemories), userSignal, detected_topic, interest_signal

**70B system prompt layers:**
1. SOUL.md personality
2. User profile + preferences
3. Memory snippets (pgvector)
4. Social graph relationships
5. Cognitive state (from 8B)
6. Tone directives (emotion → response style)
7. Tool results
8. Scene context (location, date)

**Ref:** `src/cognitive.ts` (lines 168-339), `src/llm/tierManager.ts`

---

## Memory System: pgvector + Entity Graph

### Vector Memory (Semantic Facts)
**Tables:** `memories` (768-dim Jina embeddings), `memory_history` (audit trail)
**Ref:** `src/memory-store.ts`, `database/vector.sql`

**Write path:**
1. Extract facts using Groq 8B (FACT_RETRIEVAL_PROMPT)
2. Embed facts (768 dims via Jina)
3. pgvector cosine search for similar existing memories
4. Groq 8B decides: ADD | UPDATE | DELETE | NONE
5. UPSERT to `memories` table

**Read path:**
1. Embed user query
2. pgvector cosine search → top-K similar memories
3. Inject into system prompt as `## User Memories:`

### Entity Graph (Relationships)
**Table:** `entity_relations` (source_entity, relationship, destination_entity, source/dest embeddings)
**Ref:** `src/graph-memory.ts`, `database/vector.sql`

**Write path:**
1. Groq 8B extracts entities (types: person, place, food, activity, preference, etc.)
2. Groq 8B extracts relationships (prefers, visited, stayed_at, etc.)
3. Contradiction detection (DELETE_RELATIONS_PROMPT)
4. UPSERT with confidence scoring (starts 0.70, +0.05 per mention, caps at 0.99)

**Read path:**
1. Embed query entities
2. pgvector search → similar entities (threshold 0.3)
3. PostgreSQL recursive CTE → traverse N hops, prevent cycles
4. Format as `source → relationship → destination`

### Memory Write Queue
**Table:** `memory_write_queue` (operation_type, payload JSONB, status, attempts)
**Ref:** `database/archivist.sql`
- Processes 20 pending writes every 30 seconds
- Operations: ADD_MEMORY, GRAPH_WRITE, SAVE_PREFERENCE, UPDATE_GOAL

### Session Summaries
**Table:** `session_summaries` (summary_text, vector 768-dim, message_count)
- Every 5 min: summarize inactive sessions into episodic memory

---

## Social Graph: Current Schema

**Tables in PostgreSQL:**

```sql
-- Core entities
users (user_id, channel, channel_user_id, display_name, home_location,
       authenticated, onboarding_complete, phone_number, person_id)

-- Cross-channel identity
persons (person_id, created_at)
link_codes (code CHAR(6), user_id, 10-min expiry)

-- Entity relationships
entity_relations (user_id, source_entity, source_type, relationship,
                  destination_entity, destination_type, source_embedding,
                  destination_embedding, mentions, confidence)

-- User preferences
user_preferences (user_id, category, value, confidence, mention_count,
                  affinity_score, rejected_entities, preferred_entities)
```

**What's captured:**
- User-to-entity relationships (prefers, visited, likes, dislikes)
- Entity types: person, place, food, activity, preference, accommodation, airline, date, budget, transport, cuisine
- Confidence scoring per relationship
- Affinity scoring per user preference category
- Rejection memory (rejected_entities JSONB)
- Cross-channel identity linking (persons table + link_codes)

**What's NOT captured:**
- User-to-user relationships (friendship, compatibility)
- Group membership / social circles
- Cross-user activity correlation
- Friend preference aggregation
- Shared plans / events

---

## Proactive Behavior: 12+ Cron Jobs

**File:** `src/scheduler.ts`

| Schedule | Task | Purpose |
|----------|------|---------|
| 30s | Health heartbeat | Liveness check |
| */30 min | Topic follow-ups | Send warm topic follow-ups (conf >25%, inactive 4h+) |
| */2 hours | Content blast | Generic proactive content for inactive users |
| */6 hours | Media scraping | Instagram/TikTok reels |
| */15 min | Social outbound | Friend bridge messages |
| Every hour | Rate limit cleanup | Remove stale records |
| 30 min past | Stale topic sweep | Auto-abandon topics with no signal for 72h |
| */30 min | Price alerts | Flight/hotel price monitoring |
| */30 min | Stimulus refresh | Weather + traffic + festival state |
| */2 hours | Intelligence cron | Affinity scores, rejection extraction |
| */30 min | Friend bridge outbound | Social features |
| */30 sec | Memory queue worker | Process pending memory writes |
| */5 min | Session summarization | Episodic memory creation |

**Stimulus System:** `src/stimulus/stimulus-router.ts`
- Three types: weather, traffic, festival
- Priority ranking: 1 (festival day) → 8 (clear traffic)
- Staleness threshold: 35 min
- Concurrency cap: 20 locations at once
- Output: `StimulusAction[]` with priority, message, suggestedAction

---

## Real-Time Data Pipeline

### Google Places (`src/tools/places.ts`)
- **Endpoint:** `https://places.googleapis.com/v1/places:searchNearby` (New API)
- **Fallback:** Old Places API
- **Caching:** 30 min (place list), 30 min (photo URIs, max 2000 entries)
- **Usage:** Reactive only (on user query). NOT proactive.

### OpenWeather (`src/tools/weather.ts`)
- **Endpoint:** `https://api.openweathermap.org/data/2.5/weather`
- **Caching:** 15 min
- **Usage:** Both reactive (user query) and proactive (stimulus router every 30 min)
- **Bangalore-specific:** Rain detection triggers local hints ("Silk Board will be a parking lot")

### Google Distance Matrix (`src/tools/ride-compare.ts`)
- **Endpoint:** `https://maps.googleapis.com/maps/api/distancematrix/json`
- **Caching:** 30 min per route
- **Fallback:** Haversine formula (×1.35 road factor) with ~35 Bengaluru landmark coordinates

---

## Data Access Failure Map

### Zomato (`src/tools/scrapers/zomato.ts`, 273 lines)

**Strategy stack (fastest → most robust):**
1. **Direct API** (~300ms, ~80% success) — `https://www.zomato.com/webroutes/search/autoSuggest` with `x-zomato-app: 1` header
2. **SSR Extraction** (Playwright, ~5-8s) — Extract `__PRELOADED_STATE__` from initial HTML
3. **XHR Interception** (Playwright) — Capture `/webroutes/getPage/`, `/webroutes/search/`
4. **DOM Text Fallback** (Playwright) — Parse visible text nodes

**Failure modes:**
- Direct API: 401 (auth required for some regions), 429 (rate limit) → falls through to Playwright
- SSR: Zomato may change `__PRELOADED_STATE__` shape → parser tries 4+ JSON shapes
- XHR: URL patterns change with Zomato updates → enhanced regex matching (2025+ formats)
- DOM: Selector changes → flexible CSS attribute patterns

**Caching:** 10 min TTL. **No bot account. No session persistence.**

---

### Swiggy (`src/tools/scrapers/swiggy.ts`, 340 lines)

**Strategy stack:**
1. **Direct DAPI** (~300ms) — `https://www.swiggy.com/dapi/restaurants/search/v3` with mobile UA + device pool rotation
2. **Mobile Playwright** (~5-8s) — Same DAPI intercepted from browser with mobile emulation
3. **DOM Fallback** — Text pattern matching

**Failure modes:**
- Device blocking: 5-device pool rotation; if all blocked → Playwright
- DAPI 403/429: `retryWithBackoff(3, 1000ms)` with device rotation
- Missing coordinates: defaults to Bengaluru center (12.9716, 77.5946)

**Additionally:** MCP integration via `src/tools/swiggy-mcp.ts` — tries official OAuth-based MCP first, falls back to scraper on 401/timeout.

**Caching:** 10 min TTL. **Device pool but no real account.**

---

### Ola / Uber / Rapido (`src/tools/ride-compare.ts`, 450+ lines)

**NO LIVE DATA.** Uses **hardcoded static rate cards** (Feb 2026 Bengaluru):

| Provider | Tiers | Surge |
|----------|-------|-------|
| Ola | Auto (₹30+₹15/km), Mini (₹50+₹12/km), Sedan (₹80+₹14/km) | Yes (1.2-1.7x) |
| Uber | Auto (₹25+₹15/km), Go (₹45+₹11/km), Premier (₹70+₹13/km) | Yes (1.2-1.7x) |
| Rapido | Bike (₹15+₹7/km), Auto (₹20+₹13/km) | No |
| Namma Yatri | Auto (₹30+₹15/km) | No |

**Surge heuristics:** Morning rush 1.2x, evening rush 1.4x, rain 1.7x — all static multipliers.

**Why no live data:**
- No documented API for any provider
- Would require browser automation + location spoofing (ToS violation)
- Hardcoded rates are "good enough" for estimation

**This is the biggest gap** — estimated prices can be 20-40% off actual prices, especially during real surge conditions.

---

### Blinkit (`src/tools/scrapers/blinkit.ts`, 145 lines)

**Strategy:** Playwright XHR interception only → DOM fallback
- Navigate to `https://www.blinkit.com/search?q={query}`
- Intercept `/api/v4/search`, `/api/v3/search`, `/v2/fetch_items`
- **Caching:** 15 min
- **Failure:** Retried with 2s backoff, 2 attempts max

---

### Zepto (`src/tools/scrapers/zepto.ts`, 150 lines)

**Strategy:** Playwright XHR interception → SerpAPI Google Shopping fallback ($5/1000)
- Navigate to `https://www.zepto.co/search?query={query}`
- Intercept `/api/v3/search`, `/api/v2/search`, `/listing/query`
- **Caching:** 10 min

---

### Swiggy Instamart (`src/tools/scrapers/instamart.ts`, 180 lines)

**Strategy:** Direct API → Playwright XHR → DOM fallback
- Endpoint: `https://www.swiggy.com/api/instamart/search`
- **Caching:** 10 min
- MCP fallback also available

---

### MCP Integrations (`src/tools/mcp-client.ts`)

**Official OAuth2 connections:**
- **Swiggy MCP:** Food (`mcp.swiggy.com/food`), Instamart (`/im`), Dineout (`/dineout`)
- **Zomato MCP:** `mcp-server.zomato.com/mcp`
- Token persistence in `mcp_tokens` DB table, auto-refresh on 401

**Setup:** Playwright-based OAuth flow intercepts redirect URI. Tokens stored in DB and process.env.

---

## Summary: Data Access Health

| Service | Primary Method | Success Rate | Freshness | Live Pricing | Bot Account |
|---------|---------------|-------------|-----------|-------------|-------------|
| Zomato | Direct API + Playwright | ~85% | 10 min cache | Listings only | No |
| Swiggy | MCP / DAPI + Playwright | ~80% | 10 min cache | Listings only | No |
| Ola | Static rate cards | 100% (stale) | Never | NO | No |
| Uber | Static rate cards | 100% (stale) | Never | NO | No |
| Rapido | Static rate cards | 100% (stale) | Never | NO | No |
| Google Places | Official API | ~95% | 30 min cache | N/A | API key |
| OpenWeather | Official API | ~98% | 15 min cache | N/A | API key |
| Blinkit | Playwright | ~70% | 15 min cache | Yes | No |
| Zepto | Playwright + SerpAPI | ~75% | 10 min cache | Partial | No |
