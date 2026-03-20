# Personifi-Aria: Codebase Study Guide for 4 Developers

Each developer owns one quadrant of the codebase. After studying their section, all 4 developers should be equipped to critically evaluate the architecture plan in `docs/plan.md`.

---

## Developer 1: Stimulus & Intelligence Pipeline

**Role:** Understand how Aria detects real-world events and decides when to proactively act.

### Files to Study (in order)

**Core Stimulus System:**
1. `src/stimulus/stimulus-router.ts` — How stimuli are aggregated per user, priority ranking, refresh cycle
2. `src/weather/weather-stimulus.ts` — Weather detection (rain, heatwave, cold snap, perfect weather)
3. `src/stimulus/` — All remaining files in this directory (traffic, festival stimuli)

**Intelligence Extraction:**
4. `src/intelligence/bedrock-extractor.ts` — AWS Bedrock signal extraction (urgency, desire, rejection)
5. `src/intelligence/rejection-memory.ts` — How rejected entities/categories are tracked
6. `src/intelligence/intelligence-cron.ts` — Batch preference extraction from conversations (runs every 2h)

**Proactive Content Pipeline:**
7. `src/media/proactiveRunner.ts` — THE main proactive pipeline: activity gates → 70B decision → content selection → delivery
8. `src/media/contentIntelligence.ts` — Content scoring, category cooling, user interest matching
9. `src/media/reelPipeline.ts` — How reels are fetched, scored, and selected
10. `src/media/mediaDownloader.ts` — Download from CDN → upload to Telegram

**Price Alerts (broken — needs fixing):**
11. `src/alerts/price-alerts.ts` — Flight price tracking (currently detects drops but NEVER notifies user)

**Scheduler (how it all gets triggered):**
12. `src/scheduler.ts` — All 12+ cron jobs, intervals, startup sequence

### Key Questions to Answer
- How does `proactiveRunner.ts` decide whether to send a message? Does it use stimulus data?
- Why does `price-alerts.ts` never actually send notifications? (Find the missing code)
- Is there a fusion layer that combines weather + traffic + festival into one decision? (Spoiler: no)
- How does fatigue/cooldown work? Is it sufficient?
- What model does the proactive agent use? Could it be replaced with deterministic scoring?

### Technologies to Learn

| Technology | Why It Matters | Resource |
|------------|---------------|----------|
| **Event-Driven Architecture with Redis Streams** | The plan proposes stimulus signals flowing into a fusion engine. Redis Streams is a lightweight alternative to Kafka for this. | [Redis Streams for Event-Driven Architecture](https://www.harness.io/blog/event-driven-architecture-redis-streams) |
| **ioredis (Node.js Redis client)** | Already used in codebase. Understand Streams, Pub/Sub, and caching patterns. | [ioredis GitHub](https://github.com/redis/ioredis) |
| **Google Places API (Nearby Search, Place Details)** | The plan adds Places as a proactive stimulus source (new openings, trending, quiet spots). | [Google Places API Docs](https://developers.google.com/maps/documentation/places/web-service/overview) |
| **OpenWeatherMap API** | Already used for weather stimulus. Understand the full API (alerts, historical). | [OpenWeatherMap API](https://openweathermap.org/api) |
| **Scoring/Ranking Systems** | The fusion engine uses deterministic scoring (like Meta's News Feed ranking). Understand multi-factor scoring. | [Designing Event-Driven Architecture with Redis Streams](https://medium.com/@avinash_vaidya/designing-event-driven-architecture-with-redis-streams-51d35f801b65) |

---

## Developer 2: Social Graph, Memory & Engagement

**Role:** Understand how Aria tracks user relationships, memories, preferences, and engagement states.

### Files to Study (in order)

**Social System:**
1. `src/social/friend-graph.ts` — Friend relationships (add/accept/block), affinity scoring, mutual detection
2. `src/social/squad.ts` — Group/squad management for coordinated recommendations
3. `src/social/outbound-worker.ts` — Friend bridge: how PASSIVE users get re-engaged through active friends
4. All other files in `src/social/` — Squad intent, correlated intent detection

**Memory Systems (3 layers):**
5. `src/memory-store.ts` — Vector memory: fact extraction → embedding → pgvector search → LLM decides ADD/UPDATE/DELETE
6. `src/graph-memory.ts` — Entity-relationship graph: entities, relations, contradictions, recursive CTEs
7. `src/memory.ts` — Preference memory: LLM-based extraction with confidence scoring

**Engagement & Topic Tracking:**
8. `src/pulse/` — ALL files: engagement scoring (0-100), state machine (PASSIVE→CURIOUS→ENGAGED→PROACTIVE), signal extraction
9. `src/topic-intent/index.ts` — Per-topic confidence tracking, phase transitions (noticed→probing→shifting→executing)
10. `src/topic-intent/types.ts` — Type definitions, signal deltas
11. `src/influence-engine.ts` — Maps engagement state + context → specific CTA behavior

**Archivist (Long-term Storage):**
12. `src/archivist/` — ALL files: Redis cache, memory write queue, session summaries

**Embeddings:**
13. `src/embeddings.ts` — L1 (in-process LRU) → L2 (Redis) → L3 (Jina/HuggingFace API) embedding pipeline

### Key Questions to Answer
- Can `searchGraph()` in `graph-memory.ts` query across multiple users' graphs? (Check the userId parameter)
- How does the friend bridge in `outbound-worker.ts` work? Can it detect "friend reviewed a place user is interested in"?
- What are the 5 separate LLM calls in the memory write pipeline? Could they be batched into 1?
- How does topic-intent phase transition affect Aria's behavior? Where is the strategy injected?
- What's the relationship between Pulse engagement state and Influence Engine output?

### Technologies to Learn

| Technology | Why It Matters | Resource |
|------------|---------------|----------|
| **pgvector (PostgreSQL vector search)** | Core of memory system. Understand HNSW indexes, cosine similarity, and vector operations. | [pgvector GitHub](https://github.com/pgvector/pgvector) |
| **pgvector Deep Dive** | Understand indexing strategies (HNSW vs IVFFlat) and performance tuning. | [Vector Similarity Search with pgvector](https://severalnines.com/blog/vector-similarity-search-with-postgresqls-pgvector-a-deep-dive/) |
| **PostgreSQL Recursive CTEs** | Used in `graph-memory.ts` for multi-hop graph traversal. Essential for understanding social graph queries. | [PostgreSQL CTE Docs](https://www.postgresql.org/docs/current/queries-with.html) |
| **Jina Embeddings v3** | Primary embedding provider (768-dim). Understand task types and batch API. | [Jina Embeddings](https://jina.ai/embeddings/) |
| **Graph Database Patterns in PostgreSQL** | The plan extends graph queries across friend networks. Understand adjacency list patterns. | [Graph Data in PostgreSQL](https://www.cybertec-postgresql.com/en/graph-data-in-postgresql/) |
| **LangGraph (for context, NOT for implementation)** | The original roadmap proposed this. Understand what it offers vs what our task orchestrator already does. | [LangGraph Overview](https://docs.langchain.com/oss/python/langgraph/overview) |
| **LangGraph Deep Dive** | Understand StateGraph, checkpointing, and supervisor patterns to evaluate if they add value. | [LangGraph GitHub](https://github.com/langchain-ai/langgraph) |

---

## Developer 3: LLM Pipeline, Cognitive Layer & Personality

**Role:** Understand every LLM call in the system, model routing, personality composition, and cost optimization opportunities.

### Files to Study (in order)

**LLM Infrastructure:**
1. `src/llm/tierManager.ts` — THE central LLM router: Tier 1 (8B chain), Tier 2 (70B chain), fallback logic, retry strategy, media URL stripping
2. `src/cognitive.ts` — 8B classifier: intent detection, tool routing, emotion/goal/monologue extraction, fast-path regex

**Main Message Handler (THE most important file):**
3. `src/character/handler.ts` — Read the ENTIRE file (~68KB). This is the main pipeline: sanitize → classify → parallel memory fetch → compose prompt → 70B response → fire-and-forget writes

**Personality System:**
4. `src/personality.ts` — Dynamic 8-layer system prompt composition (SOUL.md + user context + memories + graph + cognitive + tone + tool results)
5. `config/SOUL.md` — Aria's persona definition v8.0 (voice, rules, boundaries, emotional modes)
6. `src/character/mood-engine.ts` — Mood computation (userSignal × time × weekend × tool involvement)
7. `src/character/output-filter.ts` — Response policy enforcement
8. `src/character/sanitize.ts` — Prompt injection protection

**Tool Pipeline:**
9. `src/scout/reflection.ts` — 8B reflection pass after tool execution (quality check, key facts extraction)
10. `src/scout/normalizer.ts` — Price → ₹, timestamps → IST, IATA → city names
11. `src/brain/index.ts` — Brain router: tool routing, environmental context injection

**Background LLM Calls:**
12. `src/archivist/session-summaries.ts` — Session summarization (Bedrock Haiku → 8B fallback)
13. `src/media/proactiveRunner.ts` — Focus on `callProactiveAgent()` and `generateCaption()` — the LLM calls

### Key Questions to Answer
- How many total LLM calls happen per user message? (Map every call: model, tokens, blocking vs async)
- What's the token budget for the system prompt? How big can it get with tool results?
- Why do simple messages ("hi", "ok") still use the 70B model? Where would you add 8B routing?
- The memory pipeline makes 5 separate 70B calls. What do they each do? Could you batch them into 1 call with 8B?
- How does the proactive agent decide "should I send"? Is an LLM needed for this?
- What's the estimated cost per message at scale? Where are the biggest savings opportunities?

### Technologies to Learn

| Technology | Why It Matters | Resource |
|------------|---------------|----------|
| **Groq API & Function Calling** | Primary LLM provider. Understand model IDs, pricing, tool_use, JSON mode, rate limits. | [Groq API Reference](https://console.groq.com/docs/api-reference) |
| **Groq Supported Models** | Know available models (8B, 70B, tool-use variants) and their capabilities. | [Groq Models](https://console.groq.com/docs/models) |
| **Groq Tool Use Models** | Specialized models for function calling. Understand when to use these vs standard models. | [Groq Tool Use Models](https://groq.com/blog/introducing-llama-3-groq-tool-use-models) |
| **Gemini API (Fallback)** | Second provider in fallback chain. Understand pricing, JSON mode, Flash vs Pro. | [Gemini API Docs](https://ai.google.dev/gemini-api/docs) |
| **AWS Bedrock (Claude Haiku)** | Used for signal extraction. Understand InvokeModel API and pricing. | [AWS Bedrock Docs](https://docs.aws.amazon.com/bedrock/) |
| **LLM Routing / RouteLLM** | The plan routes simple→8B, complex→70B. Understand routing patterns. | [RouteLLM Paper](https://arxiv.org/abs/2406.18665) |
| **Prompt Engineering for JSON Mode** | Multiple calls use JSON mode. Understand structured output best practices. | [Groq JSON Mode](https://console.groq.com/docs/structured-output) |

---

## Developer 4: Tools, MCP, Browser Automation & Channels

**Role:** Understand all external integrations, MCP protocol, browser automation, and message delivery.

### Files to Study (in order)

**Tool Registry & Execution:**
1. `src/tools/index.ts` — All 20+ tools registered, `executeTool()` routing, `getGroqTools()` for function calling schemas
2. `src/scout/index.ts` — Scout pipeline: cache check → tool execution → 8B reflection → normalization
3. `src/scout/cache.ts` — Redis-backed tool result caching with per-tool TTLs

**MCP Integration:**
4. `src/tools/mcp-client.ts` — THE MCP transport layer: JSON-RPC calls, token management, auto-refresh on 401, DB persistence
5. `src/setup-mcp.ts` — OAuth flow for MCP servers (Playwright-based interactive login)
6. `src/tools/swiggy-mcp.ts` — Swiggy MCP client (Food + Instamart + Dineout)
7. `src/tools/zomato-mcp.ts` — Zomato MCP client (restaurant search)
8. `src/tools/travel-mcp.ts` — Travel MCP client (flights + hotels)
9. `src/tools/blinkit-mcp.ts` — Blinkit MCP client
10. `src/tools/zepto-mcp.ts` — Zepto MCP client

**Individual Tools (Direct API):**
11. `src/tools/places.ts` — Google Places API integration
12. `src/tools/weather.ts` — OpenWeatherMap integration
13. `src/tools/food-compare.ts` — Cross-platform food price comparison
14. Browse all other files in `src/tools/` — rides, directions, flights, hotels, currency, etc.

**Browser Automation:**
15. `src/browser.ts` — Playwright Extra + Stealth plugin, SSRF protection, UA rotation, resource blocking

**Channels & Delivery:**
16. `src/channels.ts` — Unified adapter interface: Telegram, WhatsApp, Slack. Media download-first pipeline.
17. `src/inline-media.ts` — Media handling in messages

**Task Orchestrator & Proactive Funnels:**
18. `src/task-orchestrator/` — ALL files: DB-backed state machine for multi-step workflows
19. `src/proactive-intent/` — ALL files: Intent-driven proactive funnels with inline buttons

**Onboarding:**
20. `src/onboarding/onboarding-flow.ts` — Multi-step user onboarding

### Key Questions to Answer
- How does `callMCPTool()` in `mcp-client.ts` handle transport, auth, and retry? Could you add a new MCP server (e.g., TON)?
- What's the difference between MCP tools (Swiggy, Zomato) and direct API tools (Places, Weather)? When should each be used?
- How does the Scout pipeline ensure data quality? What does the reflection pass actually check?
- What does `browser.ts` support today? What would need to change for agentic multi-step automation (filling forms, clicking buttons)?
- How does the task orchestrator manage state across multi-step workflows? How is it different from proactive funnels?
- How do Telegram inline buttons work with funnel steps?

### Technologies to Learn

| Technology | Why It Matters | Resource |
|------------|---------------|----------|
| **Model Context Protocol (MCP) Specification** | Core integration pattern. Understand Tools, Resources, Prompts primitives and JSON-RPC transport. | [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25) |
| **MCP Documentation** | Full docs including client/server patterns, capability negotiation, auth flow. | [MCP Docs](https://modelcontextprotocol.info/docs/) |
| **MCP 2026 Roadmap** | Where MCP is heading: transport scalability, agent communication, enterprise features. | [2026 MCP Roadmap](http://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/) |
| **MCP GitHub** | Reference implementations, TypeScript SDK, server examples. | [MCP GitHub Org](https://github.com/modelcontextprotocol) |
| **Stagehand (AI Browser Automation)** | Leading AI-native browser framework. Understand act/observe/extract primitives. Alternative to building custom agentic browser. | [Stagehand GitHub](https://github.com/browserbase/stagehand) |
| **Stagehand Docs** | Full SDK documentation, LLM integration, caching, multi-step flows. | [Stagehand.dev](https://www.stagehand.dev/) |
| **Cloudflare Browser Rendering** | Managed headless browsers on edge. Alternative to self-hosted Playwright. New /crawl endpoint (March 2026). | [Cloudflare Browser Rendering Docs](https://developers.cloudflare.com/browser-rendering/) |
| **browser-use (Python)** | The dominant open-source agentic browser library (~35K stars). Understand its architecture even if we use JS. | [browser-use GitHub](https://github.com/browser-use/browser-use) |
| **Agentic Browser Landscape 2026** | Comparison of Stagehand vs browser-use vs Playwright AI vs Cloudflare. | [Agentic Browser Landscape 2026](https://www.nohackspod.com/blog/agentic-browser-landscape-2026) |
| **Stagehand vs Playwright vs Browser-Use** | Detailed comparison for choosing the right approach. | [AI Web Automation Comparison 2026](https://www.nxcode.io/resources/news/stagehand-vs-browser-use-vs-playwright-ai-browser-automation-2026) |
| **Playwright Stealth** | Already used in codebase. Understand evasion techniques and limitations. | [Playwright Stealth Guide](https://brightdata.com/blog/how-tos/avoid-bot-detection-with-playwright-stealth) |
| **Playwright MCP** | Microsoft's official Playwright MCP server. Enables AI agents to control browsers via MCP. | [Playwright MCP Guide 2026](https://blog.hashscraper.com/posts/playwright-crawling-complete-guide-2026-from-installation-to-anti-bot-bypass-1) |
| **TON Blockchain Documentation** | Payment integration layer. Understand wallets, smart contracts, payments. | [TON Docs](https://docs.ton.org/) |
| **TON Smart Contracts** | Smart contract development for payment processing. | [TON Smart Contracts Overview](https://docs.ton.org/v3/documentation/smart-contracts/overview) |
| **TON Smart Contract Examples** | Reference implementations for payments, subscriptions. | [TON Contract Examples](https://docs.ton.org/v3/documentation/smart-contracts/contracts-specs/examples) |
| **Awesome TON Smart Contracts** | Curated tools, docs, and guides for TON development. | [awesome-ton-smart-contracts](https://github.com/dkeysil/awesome-ton-smart-contracts) |

---

## Cross-Cutting: Files ALL Developers Should Read

These files provide the glue between all 4 domains:

| File | Why Everyone Needs It |
|------|----------------------|
| `src/index.ts` | Server entry point, webhook routing, startup sequence |
| `src/hooks.ts` + `src/hook-registry.ts` | Hook interfaces (BrainHooks + BodyHooks) — the plugin boundary between Dev 1-4 |
| `src/types/` | Shared type definitions |
| `src/location.ts` + `src/location-presence.ts` | Location utilities used by stimulus, tools, and social |
| `config/SOUL.md` | Aria's personality — shapes every LLM output |
| `docs/plan.md` | The architecture plan everyone is evaluating |
| `docs/logic.xml` | System logic flow documentation |
| `docs/overview.xml` | System overview documentation |
| `package.json` | Dependencies, scripts, project config |

---

## Evaluation Checklist

After studying your section, each developer should evaluate `docs/plan.md` by answering:

1. **Does the plan correctly describe what exists today in your area?** Flag any inaccuracies.
2. **Are the proposed changes in your area feasible?** Can WU1-10 actually be built on top of what exists?
3. **What's missing?** Are there edge cases, existing code, or constraints the plan doesn't account for?
4. **Is the effort estimate realistic?** Based on code complexity you've seen, how hard are the changes?
5. **Are there better approaches?** Given your deep knowledge of the code, would you do something differently?
6. **Model selection:** Do the recommended models (8B/70B/Gemini Flash) make sense for the LLM calls in your area?
7. **Cost estimates:** Based on actual token counts you've seen in prompts, are the cost projections reasonable?

---

## Developer Overlap Matrix

This shows which work units (from plan.md) each developer should primarily own and review:

| Work Unit | Dev 1 (Stimulus) | Dev 2 (Social/Memory) | Dev 3 (LLM/Personality) | Dev 4 (Tools/MCP/Browser) |
|-----------|:-:|:-:|:-:|:-:|
| WU1: Stimulus Agent | **OWN** | review | | |
| WU2: Social Graph Agent | review | **OWN** | | |
| WU3: Fusion Engine | **OWN** | review | review | |
| WU4: Conversation Agent | | review | **OWN** | |
| WU5: Trip Planning | review | review | | **OWN** |
| WU6: LLM Cost Optimization | | | **OWN** | |
| WU7: Agentic Browser | | | | **OWN** |
| WU8: TON Integration | | | | **OWN** |
| WU9: Redis Cache | **OWN** | review | | review |
| WU10: MCP Standardization | | | | **OWN** |
