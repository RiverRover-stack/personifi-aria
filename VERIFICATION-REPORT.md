# Verification Report: Codebase → GitHub Issues → Desired Behavior

**Date:** 2026-03-20
**Scope:** 183 TypeScript files → 12 GitHub issues (#119-#130) → 3 behavior storyboards

---

## 1. File-to-Issue Mapping

### FILES TO BE CREATED (New modules)

| File | Issue | Dev |
|------|-------|-----|
| `src/fusion-engine.ts` | #119 | Dev1 |
| `soul.md` (~500 tokens) | #120 | Dev1 |
| `sentinel-soul.md` (~300 tokens) | #120 | Dev1 |
| `src/sentinel.ts` (background loop) | #121 | Dev2 |
| `src/tool-definitions.ts` (Groq schemas) | #129 | Dev4 |
| DB migration files (6 new tables) | #127 | Dev4 |
| Ollama client + infra config | #128 | Dev4 |

### FILES TO BE KILLED

| File | Lines | Issue | Dev | Replacement |
|------|-------|-------|-----|-------------|
| `src/character/mood-engine.ts` | 94 | #123 | Dev2 | Pulse FSM reads by Alpha |
| `src/influence-engine.ts` | 357 | #123 | Dev2 | Alpha reads pulse + topic directly |
| `src/media/proactiveRunner.ts` | 1192 | #123 | Dev2 | Sentinel background loop |
| `src/scheduler.ts` | 161 | #123 | Dev2 | Sentinel absorbs all 12 cron jobs |
| `src/cognitive.ts` | 592 | #125 | Dev3 | Groq native function calling |
| `src/personality.ts` | 504 | #125 | Dev3 | soul.md (~500 tokens) |
| `src/scout/index.ts` | ~200 | #125 | Dev3 | Alpha function calling + hook-registry |
| `src/scout/cache.ts` | ~100 | #125 | Dev3 | Tool caching moves to Sentinel pre-fetch |
| `src/scout/normalizer.ts` | ~80 | #125 | Dev3 | Groq handles directly |
| `src/scout/reflection.ts` | ~120 | #125 | Dev3 | brain/tool-reflection.ts keeps useful parts |

### FILES TO BE REWRITTEN

| File | Lines | Issue | Dev | Change |
|------|-------|-------|-----|--------|
| `src/character/handler.ts` | 1611 | #124 | Dev3 | 22-step → 5-step pipeline |

### FILES TO BE MODIFIED

| File | Issue | Dev | Change |
|------|-------|-----|--------|
| `src/pulse/pulse-service.ts` | #122 | Dev2 | Add Fusion mode switching |
| `src/pulse/state-machine.ts` | #122 | Dev2 | Wire Pulse FSM to Fusion feedback |
| `src/pulse/signal-extractor.ts` | #122 | Dev2 | Signal extraction feeds Fusion |
| `src/pulse/engagement-metrics.ts` | #122 | Dev2 | Pushback tracking, recovery tracking |
| `src/pulse/constants.ts` | #122 | Dev2 | Thresholds for hysteresis ±5 |
| `src/pulse/types.ts` | #122 | Dev2 | New types for mode, pushback state |

### FILES KEPT (no changes needed)

| File/Directory | Lines | Why Kept |
|----------------|-------|----------|
| `src/hook-registry.ts` | 47 | Called by Alpha for tool execution |
| `src/topic-intent/` (5 files) | ~300 | EXECUTING phase triggers Sentinel pre-fetch |
| `src/social/` (7 files incl. squad.ts, friend-graph.ts) | ~600 | Monitored by Sentinel for social cascade |
| `src/social/outbound-worker.ts` | ~200 | Triggered by Sentinel FIRE decisions |
| `src/memory-store.ts` + `memory.ts` + `graph-memory.ts` | ~800 | Writes move to Sentinel batch (async queue) |
| `src/stimulus/` (3 files) | ~300 | Refreshed by Sentinel |
| `src/tools/` (15+ tools + scrapers) | ~2000 | Mapped to Groq function definitions |
| `src/embeddings.ts` | ~100 | Used by vector memory search |
| `src/hooks.ts` | ~150 | Type definitions for BrainHooks |
| `src/channels.ts` | ~50 | Platform routing stays |
| `src/character/output-filter.ts` | ~100 | Output sanitization stays |
| `src/character/sanitize.ts` | ~80 | Input sanitization stays |
| `src/character/session-store.ts` | ~100 | DB connection pool stays |
| `src/archivist/` (7 files) | ~500 | Memory archival stays, queue processed by Sentinel |
| `src/onboarding/` | ~200 | Unaffected by architecture changes |
| `src/aws/` (5 files) | ~300 | Infrastructure stays |
| `src/utils/` (4 files) | ~200 | Utility functions stay |
| `src/weather/weather-stimulus.ts` | ~150 | Stimulus source consumed by Sentinel |
| `src/llm/` (3 files) | ~200 | tierManager may need update for Groq/Ollama split |

---

## 2. Behavior-to-Issue Mapping

### Storyboard 1: Happy Path (Proactive Default)

| Behavior | Required Component | Issue(s) | Covered? |
|----------|-------------------|----------|----------|
| Sentinel detects rain + commute + surge pricing | Sentinel scoring loop with stimulus refresh | #121 | ✅ |
| Sentinel scores per-user: `stimulus_w × pref_match × receptivity × (1-fatigue)` | Sentinel scoring pipeline | #121 | ✅ |
| Score ≥ 0.8 → FIRE → Alpha delivers proactive message | Fusion Engine threshold logic | #119 | ✅ |
| Social cascade boost (3+ friends = 1.3×) | Sentinel reads friend-graph | #121 + social/ kept | ✅ |
| Alpha crafts natural response with ~500 token soul.md | soul.md + Alpha handler | #120 + #124 | ✅ |
| Alpha executes tool (Rapido booking) via Groq function calling | Groq tool definitions + executor | #126 + #129 | ✅ |
| Fire-and-forget Pulse update after response | Handler Step 5 async writes | #124 + #122 | ✅ |
| Topic intent SHIFTING → Sentinel pre-fetches | Topic intent kept + Sentinel pre-fetch | #121 | ✅ |
| Fatigue cap: 4 messages/day (ENGAGED), 5/day (PROACTIVE) | Sentinel fatigue function | #121 + #119 | ✅ |
| 9:30 PM stimulus dropped due to fatigue | Sentinel scoring (1-fatigue) → score < threshold → DROP | #121 | ✅ |
| Outbound worker delivers to squad | outbound-worker.ts kept, triggered by Sentinel | Kept | ✅ |
| ProactiveState table for cached pre-fetches | DB migration: proactive_state table | #127 | ✅ |

**Storyboard 1 verdict: FULLY COVERED** — all 12 behaviors map to issues.

### Storyboard 2: Pushback → Retry → Back Off → Invalidation

| Behavior | Required Component | Issue(s) | Covered? |
|----------|-------------------|----------|----------|
| 1st rejection → Pulse -18 | Pulse pushback tracking | #122 | ✅ |
| Retry with different angle (social bond > event) | Fusion pushback protocol + retry counter | #119 | ✅ |
| 2nd rejection → mode switch to REACTIVE | Fusion mode switch logic + Pulse threshold | #119 + #122 | ✅ |
| Aria stays silent in REACTIVE (Sentinel BUFFERs only) | Fusion BUFFER/FIRE gating based on mode | #119 + #121 | ✅ |
| User returns on DIFFERENT topic (indoor entertainment) | Alpha detects direction mismatch | #124 | ✅ |
| Alpha writes signal packet invalidating stale ProactiveState | Signal packet writeback in handler Step 5 | #124 + #127 (signal_packets table) | ✅ |
| Sentinel reads signal packet → marks stale entries | Sentinel loop reads signal_packets | #121 | ✅ |
| Sentinel recalculates on new direction → writes new ProactiveState | Sentinel scoring with current_direction context | #121 | ✅ |
| 3 positive interactions at ENGAGED → unlock PROACTIVE again | Pulse recovery tracker | #122 | ✅ |
| First proactive after recovery uses softer threshold (0.85) | Fusion threshold adjustment | #119 | ✅ |
| Pushback tracker table (consecutive rejections, recovery count) | DB migration: pushback_tracker table | #127 | ✅ |

**Storyboard 2 verdict: FULLY COVERED** — all 11 behaviors map to issues.

### Storyboard 3: State Machine (PROACTIVE ↔ REACTIVE)

| Behavior | Required Component | Issue(s) | Covered? |
|----------|-------------------|----------|----------|
| PROACTIVE default: Aria initiates | Fusion Engine + Sentinel FIRE | #119 + #121 | ✅ |
| ENGAGED (50-79): normal proactive, threshold 0.8 | Pulse FSM + Fusion threshold | #122 + #119 | ✅ |
| PROACTIVE (80-100): aggressive proactive, threshold 0.7 | Pulse FSM + Fusion threshold | #122 + #119 | ✅ |
| REACTIVE fallback: only when proactive fails | Fusion mode state | #119 | ✅ |
| CURIOUS (25-49): reactive, rebuilding trust | Pulse FSM | #122 | ✅ |
| PASSIVE (0-24): minimal, only if asked | Pulse FSM | #122 | ✅ |
| Hysteresis ±5 prevents flapping | Pulse constants | #122 | ✅ |
| 24h half-life decay | Pulse service | #122 | ✅ |

**Storyboard 3 verdict: FULLY COVERED** — all 8 behaviors map to issues.

---

## 3. GAP ANALYSIS — Files Not Addressed by Any Issue

### GAP 1: `src/proactive-intent/` (7 files, 1250 lines) — CRITICAL

**Files:** orchestrator.ts (486), intent-selector.ts (305), funnels.ts (226), funnel-state.ts (95), analytics.ts (41), types.ts (90), index.ts (7)

**What it does:** Manages multi-step proactive "funnels" — structured conversation flows where Aria guides the user through a sequence (e.g., "interested in trek?" → "when?" → "who's coming?" → "booked!"). Has its own orchestrator, funnel state machine, and intent selector.

**The problem:** Sentinel (#121) absorbs the *scoring and triggering* of proactive messages, but `proactive-intent/` manages the *conversation flow after firing*. These are different concerns. Right now:
- `proactive-intent/orchestrator.ts` decides which funnel to start for a user
- `proactive-intent/intent-selector.ts` selects the best funnel based on context
- `proactive-intent/funnels.ts` defines the funnel templates (multi-step flows)

**Resolution options:**
1. **If Alpha + soul.md handles multi-step naturally** (via conversation context + session history), then proactive-intent can be KILLED. Its funnel logic becomes implicit in Alpha's natural conversation ability.
2. **If structured multi-step flows are still needed**, proactive-intent should be MODIFIED to work with Fusion Engine — Sentinel decides WHEN to fire, proactive-intent decides the FLOW once fired.

**Recommendation:** KILL. The whole point of Alpha with soul.md is that Aria handles conversation naturally without rigid funnel structures. The Pushback Protocol in Fusion Engine (#119) already handles retry logic. Add a note to #121 or #123 to include proactive-intent/ in the kill list.

### GAP 2: `src/brain/` (2 files, 308 lines) — MEDIUM

**Files:** index.ts (109), tool-reflection.ts (199)

**What it does:**
- `brain/index.ts` = `brainHooks` — takes classifier output, decides whether to use a tool, and executes it via hook-registry. This is the current tool routing layer.
- `brain/tool-reflection.ts` = Takes raw tool results and summarizes them for the LLM prompt.

**The problem:** `brain/index.ts` routing is replaced by Groq native function calling (#126). But `brain/tool-reflection.ts` does something useful — it formats raw tool outputs into LLM-digestible summaries. That logic still needs to live somewhere in the new pipeline.

**Resolution:**
- `brain/index.ts` → KILL (replaced by Groq function calling in #126)
- `brain/tool-reflection.ts` → MIGRATE useful `reflectToolResult()` and `buildSummaryForPrompt()` into the tool executor in #126 or #129

**Recommendation:** Add to #125 kill list (brain/index.ts) and note in #126 to absorb tool-reflection logic.

### GAP 3: `src/task-orchestrator/` (5 files, 954 lines) — MEDIUM

**Files:** orchestrator.ts (538), state-machine.ts (131), workflows.ts (143), types.ts (138), index.ts (4)

**What it does:** DB-backed state machine for multi-step task workflows (e.g., booking flows, comparison workflows). It explicitly imports `influence-engine.ts` for CTA urgency at each step.

**The problem:** This directly depends on `influence-engine.ts` which is being KILLED (#123). After the kill, task-orchestrator will break because `selectStrategy()` and `formatStrategyForPrompt()` won't exist.

**Resolution options:**
1. **KILL entirely** — if Alpha can handle multi-step tasks naturally through conversation context and Groq function calling
2. **MODIFY** — remove influence-engine dependency, simplify to just DB state tracking, let Alpha drive the conversation flow

**Recommendation:** KILL. Alpha with Groq function calling can execute multi-step tasks (cab compare → select → book) through natural conversation + tool calls. The rigid state machine adds complexity without matching the "feels like a person" goal. Add to #123 kill list.

### GAP 4: `src/intelligence/rejection-memory.ts` (277 lines) — LOW

**What it does:** Detects when users reject places/food/activities, persists rejections, and provides `getActiveRejections()` for filtering future suggestions.

**The problem:** This is actually USEFUL for the new architecture — Sentinel needs rejection memory for `prefMatch()` scoring, and Alpha needs it to avoid suggesting rejected items. But it's not explicitly addressed in any issue.

**Where it fits:** It's currently called from handler.ts (fire-and-forget) and intelligence-cron. In the new architecture:
- Real-time path: Alpha's signal packet should include rejection signals → written in handler Step 5 (#124)
- Batch path: Sentinel can call `extractRejections()` during memory processing (#121)
- Read path: `getActiveRejections()` called during context gather Step 2 (#124)

**Resolution:** KEEP, but it works without modification. The only change needed is that `intelligence-cron.ts` batch calls should move into Sentinel (#121). This is implicitly covered since #121 says "absorb intelligence cron" but rejection-memory.ts itself stays.

**Recommendation:** No new issue needed. Just confirm in #121 that Sentinel's memory batch processing calls `extractRejections()` from rejection-memory.ts.

### GAP 5: Pulse DynamoDB → PostgreSQL Migration — LOW

**File:** `src/pulse/dynamodb-store.ts`

**The problem:** Pulse currently stores data in DynamoDB. New tables (#127) are PostgreSQL. The Pulse modifications (#122) need to read/write PostgreSQL.

**Resolution:** #122 already says "rewire Pulse as Fusion feedback loop" which implies rewriting the storage layer. The `pulse_history` table in #127 covers the new schema. The DynamoDB store just needs to be swapped out.

**Recommendation:** Add explicit note in #122 that `dynamodb-store.ts` should be replaced with a PostgreSQL store using the `pulse_history` table from #127.

### GAP 6: `src/llm/tierManager.ts` — LOW

**What it does:** Manages which LLM tier to use (8B vs 70B) based on message complexity.

**The problem:** With the new architecture, there's no tier decision — Alpha always uses Groq 70B, Sentinel always uses Ollama Nemotron/Qwen. The tier manager becomes dead code.

**Recommendation:** Add to #125 kill list alongside cognitive.ts.

---

## 4. Verdict

### Can we achieve the desired behavior by resolving all 12 issues?

**YES — with 3 additions:**

The 12 issues (#119-#130) cover the **core architecture** completely. All 31 storyboard behaviors map to at least one issue. The new 5-step pipeline, Fusion Engine, Sentinel background loop, Pulse feedback, Groq function calling, and signal packet writeback are all explicitly specified.

However, 3 things need to be added to existing issues to prevent breakage:

1. **Add `src/proactive-intent/` (7 files) to the kill list** — either append to #123 or create a small follow-up. Without this, there's a dead orchestrator sitting in the codebase that nothing calls anymore.

2. **Add `src/brain/index.ts` and `src/task-orchestrator/` to the kill list** — brain/index.ts routing is replaced by Groq function calling, task-orchestrator depends on influence-engine which is being killed. Append to #125 (Dev3 kill list). Migrate `tool-reflection.ts` useful logic into #126.

3. **Add `src/llm/tierManager.ts` to the kill list** — dead code after architecture change. Append to #125.

These are all **deletions of now-redundant code**, not new features. The architecture itself is complete. The 12 issues, once resolved, will produce the agent behavior shown in all 3 storyboards.

---

## 5. Issue Dependency Order (Phases)

```
Phase 1 (parallel):
  #127 (Dev4) DB migrations ──────────── MUST BE FIRST
  #128 (Dev4) Ollama setup ────────────── MUST BE FIRST
  #119 (Dev1) Fusion Engine ───────────── needs DB tables
  #120 (Dev1) soul.md files ───────────── no dependencies

Phase 2 (parallel after Phase 1):
  #124 (Dev3) Handler rewrite ─────────── needs Fusion Engine
  #125 (Dev3) Kill cognitive/Scout/personality
  #126 (Dev3) Groq function calling ───── needs tool-definitions
  #129 (Dev4) Tool definitions ────────── needs hook-registry review

Phase 3 (after Phase 2):
  #121 (Dev2) Sentinel loop ───────────── needs handler + Fusion + Ollama

Phase 4 (after Phase 3):
  #122 (Dev2) Pulse rewire ───────────── needs Sentinel + Fusion
  #123 (Dev2) Kill old modules ────────── ONLY after replacements work

Phase 5 (after all):
  #130 (All) Integration testing ──────── validates everything
```

---

## 6. Summary Counts

| Category | Count | Lines Affected |
|----------|-------|----------------|
| Files to CREATE | 7+ | ~2000 new |
| Files to KILL | 10 confirmed + 11 gap additions | ~5,500 removed |
| Files to REWRITE | 1 (handler.ts) | 1611 → ~400 |
| Files to MODIFY | 6 (pulse/) | ~600 modified |
| Files KEPT unchanged | ~155 | ~30,000 untouched |
| Storyboard behaviors covered | 31/31 | 100% |
| Gaps found | 6 (3 require action) | 3 need issue updates |
