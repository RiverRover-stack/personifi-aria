# Prioritized Recommendations: Building the Output-First Agent

**Analysis Date:** 2026-03-17

---

## Top 3 to Implement First (Unlocks Output-First Behavior)

### Priority 1: Pending Intent Extraction + Persistence (GAP 10)
**Why first:** This is the cheapest, fastest change that immediately makes the agent smarter. Every conversation already runs through the 8B classifier — extending it to output `pending_intent` and saving to DB takes ~1 day. Once intents persist, every other proactive system has fuel to work with.

**Implementation:**
1. Extend `ClassifierResult` in `src/cognitive.ts` to include `pending_intent?: { type, text, entities, confidence }`
2. Add classifier prompt instruction: "If user expresses interest in doing something, extract as pending_intent"
3. Create `pending_intents` table (see GAP 10 schema)
4. After classification in `handler.ts`, if intent exists → `INSERT INTO pending_intents`
5. Estimated effort: **1-2 days**

### Priority 2: Unified Tick Loop + Fusion Scoring (GAPs 1, 2, 12)
**Why second:** This replaces 12 disconnected cron jobs with one intelligent decision engine. The stimulus router already aggregates environmental data — the tick loop consumes it alongside pending intents and social signals.

**Implementation:**
1. Create `src/agent/tick-loop.ts` with `AgentLoop` class
2. Create `src/agent/fusion-engine.ts` with weighted scoring
3. Move proactive cron jobs into tick loop phases
4. Keep stimulus-router as a data source (don't rewrite it)
5. Add `proactive_scores` table for audit trail
6. Start tick loop alongside Fastify server in `index.ts`
7. Estimated effort: **3-5 days**

### Priority 3: Unified Data Resolution Layer (GAPs 7, 13)
**Why third:** Every proactive trigger needs data. A unified `data-resolver.ts` with cache-first logic and per-app TTL means the tick loop can make decisions without waiting for slow scrapers.

**Implementation:**
1. Create `data_cache` PostgreSQL table (see GAP 7 schema)
2. Create `src/agent/data-resolver.ts` with strategy chains per service
3. Refactor each scraper to be callable from the resolver (they already return structured data)
4. Add background cache worker (runs every 5 min, pre-fetches for active users)
5. Estimated effort: **3-4 days**

**Total to unlock Output-First behavior: ~7-11 days of focused work.**

---

## NemoClaw/Nanobot: Port vs Build from Scratch

### Port from Nanobot

| Component | Nanobot Source | Personifi Target | Adaptation Needed |
|-----------|---------------|-----------------|-------------------|
| **Cron Service** | `cron/service.py` | Replace `node-cron` in scheduler.ts | Port Python → TypeScript; nanobot's cron supports `at`, `every`, `cron` expressions with state persistence — cleaner than raw node-cron |
| **Heartbeat Pattern** | `heartbeat/service.py` | Inspire tick-loop.ts | Two-phase pattern (trigger → LLM decision → conditional action) — port the concept, not the code |
| **Memory Consolidation** | `agent/memory.py` | Supplement session summaries | Token-aware consolidation with graceful degradation — useful for managing 70B context window |
| **Tool Registry Pattern** | `tools/base.py`, `tools/registry.py` | Refactor BodyHooks | Abstract Tool base class with JSON schema validation — cleaner than current ad-hoc tool registration |

### Build from Scratch (Nothing in NemoClaw/Nanobot)

| Component | Reason |
|-----------|--------|
| Fusion Ranking Engine | No multi-signal scoring exists in either codebase |
| Pre-Reasoning Buffer | No rolling time-window context in either |
| Social Graph Extensions | Nanobot is single-user; NemoClaw has no user concept |
| Real Account Simulation | Neither has consumer app integration |
| E-SIM Integration | Completely novel |
| Multi-User Coordination | Neither supports cross-user intelligence |
| Background Data Cache | Neither has external data freshness management |

### Port from NemoClaw

| Component | Useful? | Notes |
|-----------|---------|-------|
| Declarative policy YAML | Maybe later | Could define which APIs the bot can call, rate limits per service |
| Blueprint versioning | No | Over-engineered |
| Plugin registration SDK | No | Personifi already has BodyHooks |

---

## Per-App Data Strategy

### Zomato

**Current implementation:** `src/tools/scrapers/zomato.ts` — Direct API + Playwright SSR/XHR/DOM fallback chain
**What failed:** Direct API returns 401 for some regions; `__PRELOADED_STATE__` shape changes regularly
**Best approach:** **Option D (Combination)**

**Recommended strategy:**
1. **Primary: MCP** (already configured at `mcp-server.zomato.com/mcp`) — use OAuth tokens for official API access
2. **Fallback: Direct API** with rotating user agents + cookie jar persistence
3. **Fallback: Playwright SSR** extraction (keep existing code, it handles 4+ JSON shapes)
4. **Future: Bot account** — register Zomato account with bot's e-SIM, maintain logged-in Playwright session for personalized data (deals visible only to logged-in users)

**Estimated complexity:** Low (MCP already works; direct API mostly works; Playwright is fallback)

---

### Swiggy

**Current implementation:** `src/tools/scrapers/swiggy.ts` — DAPI with device pool rotation + Playwright mobile
**What failed:** Device pool of 5 gets exhausted; Swiggy fingerprints beyond device ID (canvas, WebGL, timing)
**Best approach:** **Option D (Combination)**

**Recommended strategy:**
1. **Primary: MCP** (already configured for food, instamart, dineout via `mcp.swiggy.com`)
2. **Fallback: DAPI** with expanded device pool (50+ device fingerprints, not just IDs) + proper browser fingerprint randomization
3. **Fallback: Bot account** — logged-in Playwright session (session cookies persist longer than anonymous)
4. **Enhancement:** Add `x-build-version` auto-detection (scrape Swiggy app store listing for latest version string)

**Estimated complexity:** Medium (MCP works but needs token maintenance; device pool expansion is straightforward; account login flow needs OTP handling)

---

### Ola

**Current implementation:** `src/tools/ride-compare.ts` — Static rate cards only
**What failed:** No live data attempted at all
**Best approach:** **Option B (Reverse-engineered mobile API)**

**Recommended strategy:**
1. **Phase 1 (Now):** Improve rate card accuracy — scrape current Ola fare pages weekly, update rate cards
2. **Phase 2 (With e-SIM):** Register Ola account → intercept mobile API via mitmproxy → replay fare estimate requests
   - Ola mobile API endpoint: `https://api.olacabs.com/v2/ride-estimate` (requires auth token + ride coordinates)
   - Auth flow: phone number + OTP → session token
3. **Phase 3:** Playwright headless browser logged into Ola web (`https://book.olacabs.com`) → intercept fare API responses

**Key challenge:** Ola's mobile API uses certificate pinning — may need Frida or similar to bypass for initial interception. Web version is easier.

**Estimated complexity:** High (mobile API interception requires significant reverse engineering; web version is moderate)

---

### Uber

**Current implementation:** `src/tools/ride-compare.ts` — Static rate cards only
**What failed:** No live data attempted
**Best approach:** **Option A (Headless browser)**

**Recommended strategy:**
1. **Phase 1 (Now):** Same as Ola — improve rate cards from public fare information
2. **Phase 2 (With e-SIM):** Register Uber account → Playwright headless on `https://m.uber.com/looking`
   - Uber web app shows fare estimates without booking
   - Set pickup/dropoff via URL params or DOM interaction
   - Intercept XHR responses containing fare breakdown
3. **Phase 3:** Mobile API interception (Uber's API is heavily monitored — web is safer)

**Key advantage:** Uber's mobile web (`m.uber.com`) shows fare estimates to logged-in users without requiring a booking. This is the easiest path.

**Estimated complexity:** Medium (web app approach is viable; main challenge is maintaining session cookies + handling 2FA)

---

### Rapido

**Current implementation:** `src/tools/ride-compare.ts` — Static rate cards only
**What failed:** No live data attempted
**Best approach:** **Option C (Lightweight HTML scraper)**

**Recommended strategy:**
1. **Phase 1 (Now):** Rate cards are reasonably accurate for Rapido (meter-based pricing, less dynamic than Ola/Uber)
2. **Phase 2:** Register Rapido account → intercept mobile API (simpler than Ola/Uber — less anti-bot protection)
   - Rapido web presence is minimal; mobile API interception is the primary path
3. **Alternative:** Rapido doesn't have a web booking interface — mobile API or keep rate cards

**Estimated complexity:** Low-Medium (rate cards are sufficient for v1; mobile API is simpler than Ola/Uber)

---

## E-SIM Architecture: Technical Pattern

### Recommended Approach: Virtual Number Service

**Provider:** MSG91 or Textlocal (India-focused, cheaper than Twilio for Indian numbers)

**Architecture:**
```
Bot Account Manager
  ├── VirtualNumberService (MSG91 API)
  │   ├── getDedicatedNumber(): string       // bot's phone number
  │   ├── onSMSReceived(webhook): void       // incoming SMS webhook
  │   └── parseOTP(message: string): string  // regex extract 4-6 digit code
  │
  ├── AccountRegistrar
  │   ├── registerAccount(service, phone)    // Playwright: navigate to signup, enter phone
  │   ├── submitOTP(service, otp)            // Playwright: enter OTP in form
  │   └── saveSession(service, cookies)      // Encrypt and store in bot_accounts table
  │
  └── SessionMaintainer
      ├── isSessionValid(service): boolean   // check if cookies still work
      ├── refreshSession(service): void      // re-login if expired
      └── handleReverification(service): void // handle periodic OTP challenges
```

**Database:**
```sql
CREATE TABLE bot_accounts (
    id UUID PRIMARY KEY,
    service VARCHAR(50),
    phone_number VARCHAR(15),
    account_status VARCHAR(20),     -- active, suspended, otp_pending, needs_reverification
    cookies_encrypted TEXT,         -- AES-256 encrypted cookie jar
    session_token TEXT,
    last_login TIMESTAMPTZ,
    last_otp_at TIMESTAMPTZ,
    login_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ
);

CREATE TABLE otp_log (
    id UUID PRIMARY KEY,
    service VARCHAR(50),
    phone_number VARCHAR(15),
    otp_code VARCHAR(10),
    received_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    status VARCHAR(20)             -- received, used, expired
);
```

**Cost estimate:** ~₹300-500/month for a dedicated Indian virtual number with SMS receiving capability.

**Security considerations:**
- Encrypt cookies at rest (AES-256 with server-side key)
- Rate-limit OTP requests (max 3 per service per hour)
- Monitor for account suspensions (if service detects bot-like behavior)
- Have backup phone numbers ready

---

## Cache System Design

### Schema

```sql
CREATE TABLE data_cache (
    cache_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service VARCHAR(50) NOT NULL,
    query_key VARCHAR(500) NOT NULL,
    data JSONB NOT NULL,
    fetched_at TIMESTAMPTZ DEFAULT NOW(),
    ttl_seconds INTEGER NOT NULL,
    fetch_method VARCHAR(50),
    is_stale BOOLEAN DEFAULT FALSE,
    staleness_flagged_at TIMESTAMPTZ,
    user_context JSONB,
    hit_count INTEGER DEFAULT 0,
    last_hit_at TIMESTAMPTZ,
    UNIQUE(service, query_key)
);

CREATE INDEX idx_cache_service_ttl ON data_cache(service, fetched_at);
CREATE INDEX idx_cache_stale ON data_cache(is_stale) WHERE is_stale = TRUE;
```

### TTL Configuration

```typescript
const CACHE_TTL: Record<string, number> = {
  'ola_fare':       5 * 60,       // 5 min — surge changes fast
  'uber_fare':      5 * 60,
  'rapido_fare':    10 * 60,      // 10 min — less dynamic
  'zomato_search':  2 * 60 * 60,  // 2 hours — restaurant listings stable
  'swiggy_search':  2 * 60 * 60,
  'blinkit_search': 60 * 60,      // 1 hour — grocery stock
  'zepto_search':   60 * 60,
  'instamart_search': 60 * 60,
  'weather':        15 * 60,      // 15 min — already exists
  'traffic':        10 * 60,
  'google_places':  6 * 60 * 60,  // 6 hours — places rarely change
  'google_distance': 30 * 60,     // 30 min — traffic affects distance
}
```

### Background Worker

```typescript
// src/agent/cache-worker.ts

class CacheWorker {
  private interval = 5 * 60 * 1000  // 5 min

  async run() {
    while (true) {
      // 1. Find entries approaching TTL (within 20% of expiry)
      const expiring = await db.query(`
        SELECT * FROM data_cache
        WHERE fetched_at + (ttl_seconds * INTERVAL '1 second') < NOW() + (ttl_seconds * 0.2 * INTERVAL '1 second')
        AND is_stale = FALSE
        ORDER BY hit_count DESC
        LIMIT 50
      `)

      // 2. Pre-fetch most-accessed entries
      for (const entry of expiring.rows) {
        try {
          const fresh = await resolve(entry.service, entry.query_key)
          if (fresh.success) {
            await updateCache(entry.service, entry.query_key, fresh.data, fresh.method)
          } else {
            await markStale(entry.cache_id)
          }
        } catch (e) {
          await markStale(entry.cache_id)
        }
      }

      await sleep(this.interval)
    }
  }
}
```

---

## Full System Architecture: New Personifi End-to-End

```
┌─────────────────────────────────────────────────────────────────┐
│                     PERSONIFI / ARIA v2                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │  Telegram     │    │  WhatsApp    │    │  Slack       │       │
│  │  Webhook      │    │  Webhook     │    │  Webhook     │       │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘       │
│         │                    │                    │               │
│         └────────────┬───────┴────────────┬──────┘               │
│                      ▼                    │                       │
│  ┌───────────────────────────┐            │                      │
│  │   REACTIVE PATH           │            │                      │
│  │                           │            │                      │
│  │  Fastify Server (index.ts)│            │                      │
│  │  ├─ Groq 8B Classifier   │            │                      │
│  │  │  ├─ Intent routing     │            │                      │
│  │  │  ├─ Tool selection     │            │                      │
│  │  │  ├─ Cognitive state    │            │                      │
│  │  │  └─ PENDING INTENT ──────────────┐  │                      │
│  │  │     EXTRACTION (NEW)  │          │  │                      │
│  │  │                       │          │  │                      │
│  │  ├─ Data Resolver (NEW)  │          │  │                      │
│  │  │  ├─ Cache first       │          │  │                      │
│  │  │  ├─ MCP fallback      │          │  │                      │
│  │  │  ├─ Account fetch     │          │  │                      │
│  │  │  └─ Scraper fallback  │          │  │                      │
│  │  │                       │          │  │                      │
│  │  ├─ Memory (pgvector)    │          │  │                      │
│  │  ├─ Graph (entity_rels)  │          │  │                      │
│  │  └─ Groq 70B Response    │          │  │                      │
│  └───────────────────────────┘          │  │                      │
│                                          │  │                      │
│  ┌───────────────────────────────────────┘  │                    │
│  │                                          │                    │
│  ▼                                          │                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │   PROACTIVE PATH (NEW)                                     │  │
│  │                                                            │  │
│  │  ┌─────────────────┐                                       │  │
│  │  │  Agent Tick Loop │  (runs every 5 min per user)         │  │
│  │  │                 │                                       │  │
│  │  │  For each active user:                                  │  │
│  │  │  1. Refresh data sources (via Cache Worker)             │  │
│  │  │  2. Build time-window context (24h rolling)             │  │
│  │  │  3. Fusion score:                                       │  │
│  │  │     ├─ Environmental stimuli (25%)                      │  │
│  │  │     ├─ Pending intents (30%)                            │  │
│  │  │     ├─ Social signals (25%)                             │  │
│  │  │     └─ Temporal context (20%)                           │  │
│  │  │  4. If score > threshold:                               │  │
│  │  │     ├─ Pre-reasoning pass (tone, timing, content)       │  │
│  │  │     └─ Send proactive message                           │  │
│  │  └─────────────────┘                                       │  │
│  │                                                            │  │
│  │  ┌─────────────────┐  ┌─────────────────┐                 │  │
│  │  │  Cache Worker    │  │  Social          │                 │  │
│  │  │  (runs 5 min)   │  │  Coordinator     │                 │  │
│  │  │                 │  │  (NEW)           │                 │  │
│  │  │  Pre-fetch data │  │                  │                 │  │
│  │  │  for active     │  │  Detect sharable │                 │  │
│  │  │  users' common  │  │  intents → find  │                 │  │
│  │  │  queries        │  │  compatible      │                 │  │
│  │  └─────────────────┘  │  friends → queue │                 │  │
│  │                       │  social messages  │                 │  │
│  │                       └─────────────────┘                  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │   DATA LAYER                                               │  │
│  │                                                            │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │  │
│  │  │ PostgreSQL   │  │  Redis       │  │  Bot Accounts     │  │  │
│  │  │              │  │              │  │  (NEW)            │  │  │
│  │  │ users        │  │ sessions     │  │                   │  │  │
│  │  │ memories     │  │ embeddings   │  │ account_manager   │  │  │
│  │  │ entity_rels  │  │ fast_cache   │  │ session_manager   │  │  │
│  │  │ user_prefs   │  │              │  │ otp_handler       │  │  │
│  │  │ pending_     │  │              │  │                   │  │  │
│  │  │   intents    │  │              │  │ Services:         │  │  │
│  │  │ user_rels    │  │              │  │ ├─ Zomato         │  │  │
│  │  │ friend_      │  │              │  │ ├─ Swiggy         │  │  │
│  │  │   activity   │  │              │  │ ├─ Ola            │  │  │
│  │  │ social_      │  │              │  │ ├─ Uber           │  │  │
│  │  │   circles    │  │              │  │ └─ Rapido         │  │  │
│  │  │ data_cache   │  │              │  │                   │  │  │
│  │  │ bot_accounts │  │              │  │ Virtual Number:   │  │  │
│  │  │ proactive_   │  │              │  │ MSG91 / Textlocal │  │  │
│  │  │   scores     │  │              │  │                   │  │  │
│  │  └─────────────┘  └──────────────┘  └──────────────────┘  │  │
│  │                                                            │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  Data Resolution Chain (per service)                  │  │  │
│  │  │  cache → MCP → direct API → account fetch →          │  │  │
│  │  │  playwright → DOM fallback → stale cache              │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │   INTELLIGENCE LAYER                                       │  │
│  │                                                            │  │
│  │  Stimulus Router ─── Weather / Traffic / Festival          │  │
│  │  Intelligence Cron ─ Affinity scoring / Rejection memory   │  │
│  │  Fusion Engine (NEW) ─ Multi-signal composite scoring      │  │
│  │  Pre-Reasoning Buffer (NEW) ─ Rolling 24h context window   │  │
│  │  Social Coordinator (NEW) ─ Cross-user event propagation   │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Roadmap

### Week 1: Foundation
- [ ] Pending intent extraction + `pending_intents` table (GAP 10)
- [ ] `data_cache` table + basic data resolver (GAP 7, 13)
- [ ] Extend social graph: `user_relationships` table (GAP 4)

### Week 2: Tick Loop
- [ ] Agent tick loop (`agent-loop.ts`) (GAP 12)
- [ ] Fusion scoring engine (`fusion-engine.ts`) (GAP 2)
- [ ] Pre-reasoning buffer (`pre-reasoning-buffer.ts`) (GAP 3)
- [ ] Migrate proactive cron jobs into tick loop (GAP 1)

### Week 3: Data Layer
- [ ] Background cache worker (GAP 7)
- [ ] Virtual number service setup (MSG91/Textlocal) (GAP 9)
- [ ] Bot account registration: Zomato + Swiggy (GAP 8)
- [ ] Unified resolution chain for food platforms

### Week 4: Social Intelligence
- [ ] Social coordinator — cross-user intent broadcasting (GAP 11)
- [ ] `friend_activity` + `social_circles` tables (GAP 4)
- [ ] Compatibility score algorithm
- [ ] Integration testing: tick loop + fusion + social

### Week 5-6: Ride Platform Live Data
- [ ] Uber web fare estimation via Playwright (GAP 6, 8)
- [ ] Ola web/API fare estimation (GAP 6, 8)
- [ ] Replace static rate cards with live data + rate card fallback
- [ ] End-to-end testing of full Output-First agent behavior

---

## New Files to Create (Summary)

```
src/agent/
  ├── tick-loop.ts            -- Continuous agent evaluation loop
  ├── fusion-engine.ts        -- Multi-signal composite scoring
  ├── pre-reasoning-buffer.ts -- Rolling time-window context
  ├── data-resolver.ts        -- Unified data access with fallback chains
  ├── data-pipeline.ts        -- Background data refresh for active users
  ├── cache-worker.ts         -- Pre-fetch expiring cache entries
  ├── social-coordinator.ts   -- Cross-user intent broadcasting
  └── accounts/
      ├── account-manager.ts  -- Manages bot accounts across services
      ├── session-manager.ts  -- Maintains logged-in Playwright sessions
      ├── otp-handler.ts      -- Virtual number OTP handling
      ├── cookie-store.ts     -- Encrypted cookie persistence
      └── providers/
          ├── zomato-account.ts
          ├── swiggy-account.ts
          ├── ola-account.ts
          ├── uber-account.ts
          └── rapido-account.ts

database/migrations/
  ├── 00X-pending-intents.sql
  ├── 00X-data-cache.sql
  ├── 00X-social-graph-v2.sql
  ├── 00X-bot-accounts.sql
  └── 00X-proactive-scores.sql
```
