# Aria — Agent Fix Prompts & Memory Architecture
**Branch:** `dev/fusion-architecture-v2`
**Date:** 2026-03-29
**Purpose:** Self-contained prompts for an AI coding agent to fix every production blocker, implement the recency memory architecture, and complete the missing stubs.

---

## How to Use These Prompts

Each prompt below is **self-contained** — paste it directly into Claude Code (or any agentic coding tool) with the repo open. They are ordered by priority: start at P0 and work down. Each prompt tells the agent exactly which file to edit, what the current code does wrong, what it should do instead, and what a passing test looks like.

---

## Part 1 — Production Blockers (Fix These First)

---

### PROMPT P0-A: Fix IST Time Calculation Bug
**File:** `src/fusion/proactive.ts` ~line 100
**Effort:** 20 minutes

```
You are working in the personifi-aria TypeScript codebase on branch dev/fusion-architecture-v2.

FILE TO FIX: src/fusion/proactive.ts

PROBLEM:
Line ~100 has this IST calculation:
  const istHour = (now.getUTCHours() + 5) % 24 + (now.getUTCMinutes() + 30) / 60

This is wrong. At 2:30 UTC (which should be 8:00 IST), this yields 7.5 — failing the
`istHour < 8` check and silently dropping proactive messages for the first 30 minutes
of the 8am–10pm active window.

The correct approach (already used correctly in src/sentinel/decision-engine.ts
`isWithinActiveHours()`) is:
  const totalMinutesUTC = now.getUTCHours() * 60 + now.getUTCMinutes()
  const istMinutes = (totalMinutesUTC + 330) % (24 * 60)
  const istHour = istMinutes / 60

FIX:
1. Open src/fusion/proactive.ts
2. Replace the broken line with the correct formula above
3. Also add a helper function `getISTHour(date: Date): number` at the bottom of the file
   so the logic is reusable and testable
4. Update the if-condition to use the new helper

ALSO CHECK:
- Search for any other place in src/fusion/ that does manual IST calculation and apply
  the same fix if found

WRITE A TEST:
In src/fusion/fusion-engine.test.ts, add a test called "IST boundary: 2:30 UTC fires,
2:29 UTC buffers" that creates a Date at 2:30:00 UTC and 2:29:00 UTC and asserts the
correct BUFFER vs FIRE decision.

Do not change any other logic. Only fix the time calculation.
```

---

### PROMPT P0-B: Enforce Daily Fatigue Limit in Pulse
**File:** `src/pulse/pulse-service.ts`
**Effort:** 2–3 hours

```
You are working in the personifi-aria TypeScript codebase.

CONTEXT:
The Sentinel decision-engine (src/sentinel/decision-engine.ts) already checks
ctx.dailyFireCount against DAILY_FIRE_LIMIT_DEFAULT (3) and DAILY_FIRE_LIMIT_PROACTIVE (5).
However, ctx.dailyFireCount comes from src/sentinel/state-store.ts and is incremented
by incrementDailyFire(). The issue is there is NO daily reset in the DB — the count
accumulates indefinitely and `resetDailyCountsIfNeeded` in state-store.ts needs verification.

TASK 1: Verify resetDailyCountsIfNeeded in src/sentinel/state-store.ts
- Read the function. Confirm it checks if `last_reset_date` != today IST, and if so,
  resets `daily_fire_count = 0` and updates `last_reset_date`.
- If this is NOT implemented, implement it:
  UPDATE sentinel_user_state
  SET daily_fire_count = 0, last_reset_date = $currentDateIST
  WHERE user_id = $userId AND last_reset_date != $currentDateIST

TASK 2: Verify the DB schema has last_reset_date
- Check database/proactive.sql or the relevant sentinel state table
- If last_reset_date column is missing, create a migration file at
  database/migrations/010-sentinel-daily-reset.sql with:
  ALTER TABLE sentinel_user_state ADD COLUMN IF NOT EXISTS last_reset_date DATE;
  UPDATE sentinel_user_state SET last_reset_date = CURRENT_DATE;

TASK 3: Add a reactive-mode guard
- In src/fusion/reactive.ts, before injecting any buffered stimulus context,
  read the user's proactiveCountToday. If it equals or exceeds the pulse-based limit,
  skip stimulus injection (fatigue applies to reactive context injection too).
- The limit is: pulseState === 'PROACTIVE' ? 5 : 3

WRITE A TEST:
In src/sentinel/sentinel-loop.test.ts (or decision-engine.test.ts), add:
"Daily limit: 4th FIRE in ENGAGED state returns DROP"
- Set up ctx with pulseState='ENGAGED', dailyFireCount=3
- Pass a stimulus with compositeScore=0.9
- Assert the decision is DROP with reason containing 'Daily fire limit'

Do not touch the Pulse FSM score logic. Only the daily fire counter and reset.
```

---

### PROMPT P0-C: Remove influence-engine.ts from Hot Path
**File:** `src/influence-engine.ts`, `src/character/handler.ts`, `src/task-orchestrator/orchestrator.ts`, `src/inline-media.ts`
**Effort:** 1 day

```
You are working in the personifi-aria TypeScript codebase.

BACKGROUND:
src/influence-engine.ts is an architecture-killed module that is still actively imported
in handler.ts, orchestrator.ts, and inline-media.ts. It runs selectStrategy() and
formatStrategyForPrompt() in the hot path, creating a second parallel routing layer
that conflicts with the Fusion Engine. This module is scheduled for deletion per the
recalibrated architecture spec.

WHAT influence-engine DOES (summary):
- selectStrategy(pulseState, context) → InfluenceStrategy
  Maps engagement state + context (tool used, time, weekend, userSignal) to a
  directiveLine, ctaStyle, offeredActions, mediaHint
- formatStrategyForPrompt(strategy) → string
  Formats the strategy as a Layer 7d prompt injection

WHERE IT'S USED:
1. src/character/handler.ts: calls selectStrategy() and injects formatStrategyForPrompt()
   as a layer in the system prompt
2. src/task-orchestrator/orchestrator.ts: uses it for task routing directives
3. src/inline-media.ts: uses it for media suggestion hints

MIGRATION PLAN:
The directiveLine concept belongs in the Alpha prompt builder. The ctaStyle/offeredActions
concept belongs in the Fusion Engine's mode output.

STEP 1: In src/alpha/alpha-prompt-builder.ts, find where the system prompt is assembled.
Add a new helper function buildModeDirective(pulseState: EngagementState, mode: FusionMode): string
that produces a concise directive line based on pulse state and fusion mode:
  - PROACTIVE: "Aria is proactively guiding this conversation. Be warm, specific, action-oriented."
  - ENGAGED: "User is engaged. Move toward a useful outcome. Offer a concrete next step."
  - CURIOUS: "User is rebuilding trust. Be helpful, ask one good question, don't push."
  - PASSIVE: "User is passive. Just answer what's asked. No CTAs."
Use this in the prompt builder wherever the Layer 7d directive was injected.

STEP 2: In src/character/handler.ts:
- Remove the import of selectStrategy and formatStrategyForPrompt from influence-engine
- Remove the call to selectStrategy() and the injection of formatStrategyForPrompt()
- Replace with a call to buildModeDirective() from alpha-prompt-builder
- If the handler falls back to legacy generateResponse() rather than callAlpha(),
  inline a simple pulse-state directive string directly

STEP 3: In src/task-orchestrator/orchestrator.ts:
- Remove the influence-engine import
- Replace selectStrategy() calls with a direct pulse state check:
  if (pulseState === 'PROACTIVE') { ... } else { ... }

STEP 4: In src/inline-media.ts:
- Remove the influence-engine import
- Replace mediaHint with a simple boolean: show media when pulseState is ENGAGED or PROACTIVE

STEP 5: Once all imports are removed, delete src/influence-engine.ts

VERIFY: Run `grep -r "influence-engine" src/` after deletion — should return no results.

WRITE A TEST:
Add to src/alpha/alpha-prompt-builder.test.ts (create if missing):
"buildModeDirective returns correct directive for each pulse state"
- Test all 4 states: PASSIVE, CURIOUS, ENGAGED, PROACTIVE
- Assert each returns a non-empty string

Do NOT change the Fusion Engine logic. Only remove the influence-engine and replace
with the simplified directive in the prompt builder.
```

---

### PROMPT P1-A: Implement Social Overlay — Squad Convergence
**File:** `src/sentinel/social-overlay.ts`
**Effort:** 1–2 days

```
You are working in the personifi-aria TypeScript codebase.

FILE TO FIX: src/sentinel/social-overlay.ts

PROBLEM:
The function applySocialOverlay() currently returns { ...stimulus, socialBoost: 1.0 }
— a stub. The entire social cascade feature is non-functional. Without this, a "3/5 squad
heading to Meghana's" scenario scores ~0.56 instead of the required 0.91 that crosses
the FIRE threshold.

CONSTANTS ALREADY DEFINED (in src/sentinel/constants.ts):
  SOCIAL_CONVERGENCE_BOOST = 1.3   // multiplier when 3+ friends interested in same topic
  SOCIAL_SQUAD_BOOST = 0.10        // additive bonus when active squad discussion happening

SOCIAL GRAPH MODULES AVAILABLE:
  src/social/squad.ts — getSquadsForUser(userId)
  src/social/squad-intent.ts — detectCorrelatedIntents(squadId, category, hoursWindow)
  src/social/friend-graph.ts — getFriendIds(userId)

SQUAD_INTENTS TABLE (in database/social.sql):
  squad_intents: squad_id, user_id, intent_text, category, detected_at

TASK:
Implement applySocialOverlay() as follows:

1. Map stimulus.stimulus.type to an intent category:
   - 'food' / 'mess_menu' → 'food'
   - 'local_event' / 'event' → 'event'
   - 'weather' / 'traffic' → null (no social boost for utility stimuli)
   - Any stimulus with data.category field → use that directly

2. If category is null, return the stimulus unchanged (socialBoost: 1.0)

3. Query squad_intents for the user's squad(s):
   SELECT COUNT(DISTINCT si.user_id) as member_count
   FROM squad_members sm
   JOIN squad_intents si ON si.squad_id = sm.squad_id
   WHERE sm.user_id = $userId
     AND si.category = $category
     AND si.detected_at > NOW() - INTERVAL '4 hours'
     AND si.user_id != $userId

4. Compute boost:
   - memberCount >= 3: boost = SOCIAL_CONVERGENCE_BOOST (1.3)
   - memberCount >= 1 AND memberCount < 3: boost = 1.15 (partial boost)
   - memberCount === 0: boost = 1.0

5. Check for active squad discussion (last 30 min):
   SELECT COUNT(*) FROM squad_intents
   WHERE squad_id IN (user's squads) AND detected_at > NOW() - INTERVAL '30 minutes'
   If count > 0: add SOCIAL_SQUAD_BOOST (0.10) to the final compositeScore AFTER the multiply

6. Return:
   {
     ...stimulus,
     compositeScore: Math.min(stimulus.compositeScore * boost + (activeDiscussion ? 0.10 : 0), 1.0),
     socialBoost: boost
   }

7. Wrap ALL DB queries in try/catch — if anything fails, return stimulus unchanged (fail-open)

WRITE TESTS:
In src/sentinel/social-overlay.test.ts (create this file):
- "No boost for weather stimulus" — type='weather', should return socialBoost: 1.0
- "3 friends interested in food → 1.3x boost" — mock DB to return memberCount=3
- "Active squad discussion adds 0.10" — mock both memberCount=3 and active discussion
- "DB failure returns stimulus unchanged" — mock query to throw, assert original score returned
- Score never exceeds 1.0 after boost
```

---

### PROMPT P1-B: Hydrate User Preferences in Sentinel Loop
**File:** `src/sentinel/state-store.ts`
**Effort:** 2–3 hours

```
You are working in the personifi-aria TypeScript codebase.

PROBLEM:
In src/sentinel/sentinel-loop.ts, the user context loaded by loadSentinelUsersWithContext()
has preferences: {} — empty. This means prefMatch() in fusion/scoring.ts always falls to
default 0.3. Dietary, entertainment, commute, and budget preferences are never applied
to stimulus scoring.

FILE TO EDIT: src/sentinel/state-store.ts

FIND: The loadSentinelUsersWithContext() function (or the SQL query it uses).

CURRENT SQL (roughly):
  SELECT u.user_id, pes.current_state, pes.engagement_score, ...
  FROM users u
  LEFT JOIN pulse_engagement_scores pes ON ...
  ...

REQUIRED CHANGE:
Add a subquery or LEFT JOIN to load user preferences:

  LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(category, value) as prefs
    FROM user_preferences
    WHERE user_id = u.user_id
  ) up ON true

Then map `up.prefs` into the SentinelUserContext.preferences field.

The SentinelUserContext type should already have preferences: Record<string, string>
(check src/sentinel/types.ts — if it only has preferences: {}, update the type comment
to clarify it should be populated).

ALSO: Add a column index if not present:
  CREATE INDEX IF NOT EXISTS user_preferences_user_id_idx ON user_preferences (user_id);

VERIFY: In src/fusion/scoring.ts, find prefMatch(). Confirm it reads from
userCtx.preferences[category]. If preferences is now populated with real data from DB,
the scoring should automatically improve. Add a log statement (debug level) when
prefMatch finds a preference hit.

WRITE A TEST:
In src/sentinel/sentinel-loop.test.ts:
"User preferences loaded: dietary veg scores higher for veg restaurant"
- Mock the DB to return a user with preferences: { dietary: 'veg' }
- Create a food stimulus with data containing 'veg' keywords
- Assert compositeScore > 0.3 (the default fallback)

Do not change the scoring formula. Only fix the data loading.
```

---

### PROMPT P1-C: Implement collectSocialMonitor Collector
**File:** `src/sentinel/collectors.ts`
**Effort:** 1–2 days

```
You are working in the personifi-aria TypeScript codebase.

PROBLEM:
In src/sentinel/collectors.ts, the function collectSocialMonitor() is a stub that
returns []. This means social convergence stimuli (squad members doing the same thing)
are never generated — even though the scoring and overlay systems are ready to handle them.

CONTEXT:
Social stimuli are the most valuable category for college users. Examples:
- 3/5 squad members have expressed intent to go for lunch → stimulus
- A friend just shared their location at a place the user mentioned wanting to visit → stimulus
- 2 friends mentioned "Nandi Hills" in the last 2 hours → stimulus

AVAILABLE MODULES:
  src/social/squad-intent.ts — detectCorrelatedIntents(squadId, category, hoursWindow)
    Returns CorrelatedIntent[] with { category, count, memberNames, recentMessages }
  src/social/squad.ts — getSquadsForUser(userId) → Squad[]
  src/social/friend-graph.ts — getFriendIds(userId) → string[]
  database/social.sql — squad_intents table schema

IMPLEMENT collectSocialMonitor(userId: string): Promise<StimulusInput[]>:

1. Get user's squads: const squads = await getSquadsForUser(userId)
   If no squads, return []

2. For each squad, call detectCorrelatedIntents(squad.id, null, 2) to get intents from
   the last 2 hours across all categories.

3. Filter: only keep correlated intents where count >= 2 (at least 2 friends, not just 1)

4. For each correlated intent, create a StimulusInput:
   {
     type: 'social_convergence',
     key: `social_${squadId}_${intent.category}_${Date.now()}`,
     weight: 0.75,  // social stimuli are high-value
     data: {
       message: `${intent.memberNames.slice(0, 2).join(' and ')} ${intent.count > 2 ? `and ${intent.count - 2} others are` : 'are'} talking about ${intent.category}`,
       suggestedAction: `Join the conversation`,
       hashtag: `#squad_${intent.category}`,
       priority: intent.count >= 3 ? 'high' : 'medium',
       memberCount: intent.count,
       memberNames: intent.memberNames,
       category: intent.category,
       raw: intent,
     }
   }

5. Deduplicate by category: if the same category appears from multiple squads,
   keep only the one with the highest count.

6. Return the array (empty if no correlated intents found)

7. All wrapped in try/catch — any DB failure returns []

WRITE TESTS:
In src/sentinel/collectors.test.ts (create if missing):
- "collectSocialMonitor returns [] when user has no squads"
- "collectSocialMonitor returns stimulus when 2+ friends share food intent"
- "collectSocialMonitor deduplicates same category across squads"
- "collectSocialMonitor returns [] on DB error (fail-open)"
```

---

### PROMPT P1-D: Implement collectTopicFollowup Collector
**File:** `src/sentinel/collectors.ts`
**Effort:** 3–4 hours

```
You are working in the personifi-aria TypeScript codebase.

PROBLEM:
collectTopicFollowup() in src/sentinel/collectors.ts is a stub returning [].
Warm topic re-engagement — where Aria notices a topic the user mentioned 2+ days ago
that hasn't been resolved — never fires.

CONTEXT:
Example: user mentioned "want to try that new ramen place" 2 days ago. Aria
detected this as a topic_intent with category 'food'. No follow-up happened.
Sentinel should generate a stimulus: "By the way, did you ever try that ramen place?"

AVAILABLE DATA:
  Table: topic_intents (user_id, topic, category, confidence, phase, signals, last_updated)
  Phases: 'EMERGING' | 'BUILDING' | 'SHIFTING' | 'STABLE' | 'ABANDONED'

IMPLEMENT collectTopicFollowup(userId: string): Promise<StimulusInput[]>:

1. Query topic_intents:
   SELECT topic, category, confidence, phase, last_updated
   FROM topic_intents
   WHERE user_id = $userId
     AND phase NOT IN ('ABANDONED')
     AND last_updated < NOW() - INTERVAL '36 hours'    -- hasn't been discussed in 36h
     AND last_updated > NOW() - INTERVAL '7 days'      -- but not too stale (within 7 days)
     AND confidence > 0.4                               -- only reasonably confident topics
   ORDER BY confidence DESC
   LIMIT 3

2. For each topic, create a StimulusInput:
   {
     type: 'topic_followup',
     key: `topic_followup_${userId}_${topic.topic}`,
     weight: 0.55,
     data: {
       message: `Re-engagement opportunity: user mentioned '${topic.topic}' (${topic.category}) ${Math.floor((Date.now() - topic.last_updated.getTime()) / 3600000)}h ago`,
       suggestedAction: 'Bring it up naturally',
       hashtag: `#${topic.category}_followup`,
       priority: topic.confidence > 0.7 ? 'medium' : 'low',
       topicName: topic.topic,
       topicCategory: topic.category,
       hoursAgo: Math.floor((Date.now() - topic.last_updated.getTime()) / 3600000),
       raw: topic,
     }
   }

3. Wrapped in try/catch — DB failure returns []

WRITE TESTS in src/sentinel/collectors.test.ts:
- "topic_followup: returns stimulus for warm topic not discussed in 2 days"
- "topic_followup: ignores topics discussed recently (< 36h)"
- "topic_followup: ignores ABANDONED topics"
- "topic_followup: returns [] on DB error"
```

---

### PROMPT P2-A: Fix Tool Execution Threshold in reactive.ts
**File:** `src/fusion/reactive.ts` ~line 96
**Effort:** 30 minutes

```
You are working in the personifi-aria TypeScript codebase.

FILE: src/fusion/reactive.ts

PROBLEM:
Around line 96, there is a hardcoded threshold check:
  if (score >= 0.8) { // execute tool }

This ignores the user's current mode threshold. A PROACTIVE user has a threshold of 0.7,
meaning they miss tool executions for scores between 0.7–0.8.

FIX:
1. Import getFusionMode from src/fusion/mode-switch.ts
2. Replace the hardcoded 0.8 with the mode-based threshold:
   const mode = getFusionMode(userCtx.pulseState)
   if (score >= mode.threshold) { // execute tool }

VERIFY: Search for any other hardcoded 0.8 thresholds in src/fusion/ that should
use the dynamic mode threshold and fix those too.

No new tests needed for this — it's covered by the existing fusion-engine.test.ts if
you add one test case:
"reactive: PROACTIVE user (pulse 85) executes tool at score 0.75"
```

---

### PROMPT P2-B: Add Integration Tests for reactive.ts Direction Mismatch
**File:** `src/fusion/fusion-engine.test.ts`
**Effort:** 1 day

```
You are working in the personifi-aria TypeScript codebase.

PROBLEM:
fusionReactiveDecision() in src/fusion/reactive.ts has zero tests. Direction mismatch
detection, context injection, and signal packet writing are all unverified in CI.

TASK: Add integration tests for the full reactive decision flow.

Read src/fusion/reactive.ts fully before writing tests to understand:
- detectDirectionMismatch(userMessage, bufferedProactiveState)
- How signal packets are written back { invalidated: [...], current_direction, intents }
- How Alpha injects buffered context when direction matches

WRITE THESE TESTS in src/fusion/fusion-engine.test.ts:

Test 1: "Direction match: buffered food stimulus injected when user asks about food"
- User message: "what's good to eat near campus?"
- Buffered ProactiveState: { type: 'food', stimulusKey: 'meghana_biryani', ... }
- Assert: fusionReactiveDecision returns contextInjected=true, stimulus in output

Test 2: "Direction mismatch: stale comedy show not injected when user asks about streaming"
- User message: "what should I watch tonight?"
- Buffered ProactiveState: { type: 'local_event', stimulusKey: 'comedy_show_blr', ... }
- Assert: fusionReactiveDecision returns contextInjected=false
- Assert: signal packet written with invalidated: ['comedy_show_blr'],
          current_direction: 'indoor_entertainment'

Test 3: "Direction mismatch: Sentinel signal packet written to DB"
- Same setup as Test 2 but mock the DB write
- Assert: the correct invalidation record was written

Test 4: "No buffered state: reactive responds to message without proactive context"
- No buffered ProactiveState for user
- Assert: fusionReactiveDecision works without error, contextInjected=false

Test 5: "Recovery: after 3 positive interactions, proactive mode re-enabled"
- Set up user with mode=REACTIVE, consecutivePositive=2
- Simulate one more positive interaction (score delta > 0)
- Assert: mode transitions to PROACTIVE, recoveryThreshold applied correctly

Use dependency injection / mocks for DB calls. Do not make real DB calls in unit tests.
```

---

### PROMPT P2-C: Add committed_action Signal Weight
**File:** `src/pulse/signal-extractor.ts`
**Effort:** 2 hours

```
You are working in the personifi-aria TypeScript codebase.

FILE: src/pulse/signal-extractor.ts

PROBLEM:
The storyboard specifies +22 pulse delta for a "committed action" (e.g., user says
"book it" or confirms a purchase/plan). Current weights: urgency=14, desire=10,
fastReply=8. No single signal captures the committed action at +22.

FIX:
1. Add a new signal type 'committed_action' to the signal weight constants
   (in src/pulse/constants.ts if separate, or inline):
   SIGNAL_WEIGHTS.committed_action = 22

2. In extractEngagementSignals(), add detection for committed action patterns:
   const COMMITTED_ACTION_PATTERNS = [
     /\b(book it|booked|done|confirmed|i'll take it|order it|ordered|yes do it|yeah go ahead|reserve|reserved)\b/i,
     /\b(let's go|i'm in|count me in|i'll join|joining)\b/i,
   ]

   If any pattern matches the user message AND there was a tool result this turn
   (hint: check if toolResult is present in the input), add 'committed_action' signal.

3. The +22 should be the TOTAL for this signal — do not double-count with urgency/desire.
   Use an exclusive check: if committed_action detected, skip urgency and desire for
   this turn (or cap the combined delta at 22 to avoid inflation).

WRITE A TEST:
"committed_action: 'book it' after tool result gives +22 delta"
"committed_action: 'book it' without tool result does NOT give +22 (normal urgency only)"
```

---

## Part 2 — Memory Architecture (Recency Layer)

---

### ARCHITECTURE DECISION RECORD: Recency-Based Memory System

**Status:** Proposed
**Decision:** Replace indefinite raw message storage with a 4-tier recency memory model

#### The Problem

The current system stores all messages in the `sessions` table indefinitely. As conversations grow:
- Context windows fill with old, irrelevant exchanges
- Sentinel scores context equally whether it's 2 hours or 2 months old
- Plans the user made (coffee with friends, weekend trek) disappear from context with no stimulus trigger
- Social graph bond scores are static — they don't reflect recent activity

#### The Vision (from conversation with Adi)

- Sentinel's proactive reasoning should be **recency-first**: what did we talk about in the last 7 days?
- Plans that didn't materialize become future stimuli (planned coffee on Saturday → reminder Thursday)
- Long-term agent behavior (bond scores, preference confidence, squad similarity) is shaped by weekly patterns, not individual messages
- Raw conversation data older than 7 days is archived to S3, not kept in hot DB

#### The 4-Tier Memory Model

```
TIER 1: HOT (0–24 hours)
  Table: sessions (existing)
  Content: Raw messages, current session
  Who reads it: Alpha (full conversation context), Sentinel (last N messages)
  Retention: Full messages, 24h active window

TIER 2: RECENT (1–7 days)
  Table: session_summaries (existing, but needs timestamp-gated queries)
  Content: 2-4 sentence episodic summaries, generated after 30 min inactivity
  Who reads it: Alpha context-manager (recency boost), Sentinel topic_followup collector
  Retention: Summary text + embedding, 7 days

TIER 3: WEEKLY DIGEST (7 days → permanent, compact)
  Table: weekly_digests (NEW — see schema below)
  Content: Structured extract: plans made, preferences discovered, social patterns,
           unresolved intents, mood trends for the week
  Who reads it: Sentinel (weekly_summary collector), Social graph bond updater
  Retention: Permanent (compact JSON, ~500 chars per week)

TIER 4: LONG-TERM IMPACT (permanent, highly compressed)
  Tables: memories (vector), entity_relations (graph), user_relationships (bond scores)
  Content: Key facts, durable preferences, social graph edge weights
  Who reads it: Alpha context manager, Sentinel social overlay
  Retention: Permanent, updated incrementally from weekly digests
```

#### The "Unresolved Plans" Stimulus Pipeline

When Aria detects a concrete plan in conversation ("let's grab coffee Saturday",
"we're thinking Nandi Hills next weekend"), it should:

1. Store the plan in a new `conversation_plans` table with `planned_for` date
2. Sentinel's `collectTopicFollowup` checks for plans with `planned_for` in the next 48 hours → generates a reminder stimulus
3. After `planned_for` passes, check if a follow-up conversation happened:
   - If yes → mark COMPLETED, extract memory ("User went on Nandi Hills trek with squad")
   - If no → mark UNRESOLVED, include in weekly digest as "plans that didn't happen"
4. Unresolved plans re-surface in the next relevant context window as a social stimulus

---

### PROMPT M1: Add conversation_plans Table and Extraction
**Files:** `database/migrations/011-conversation-plans.sql`, `src/intelligence/plan-extractor.ts`, `src/sentinel/collectors.ts`
**Effort:** 2–3 days

```
You are working in the personifi-aria TypeScript codebase.

TASK: Build the conversation_plans table and the pipeline that populates it.

STEP 1: Create database/migrations/011-conversation-plans.sql

CREATE TABLE IF NOT EXISTS conversation_plans (
    plan_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    session_id      UUID REFERENCES sessions(session_id) ON DELETE SET NULL,
    plan_text       TEXT NOT NULL,            -- raw extracted text: "grab coffee Saturday"
    plan_type       VARCHAR(30) NOT NULL      -- 'social', 'food', 'activity', 'study', 'other'
                    CHECK (plan_type IN ('social', 'food', 'activity', 'study', 'travel', 'other')),
    participants    JSONB DEFAULT '[]',        -- ["Rahul", "Priya"] or user_ids if known
    planned_for     TIMESTAMPTZ,              -- extracted date/time (null if vague)
    planned_for_raw TEXT,                     -- original text: "this Saturday", "next weekend"
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'reminded', 'completed', 'unresolved', 'cancelled')),
    resolution_note TEXT,                     -- populated by weekly digest pipeline
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS conv_plans_user_upcoming_idx
    ON conversation_plans (user_id, planned_for)
    WHERE status = 'pending' AND planned_for IS NOT NULL;

CREATE INDEX IF NOT EXISTS conv_plans_user_unresolved_idx
    ON conversation_plans (user_id, created_at)
    WHERE status = 'unresolved';

STEP 2: Create src/intelligence/plan-extractor.ts

This module is called by the archivist pipeline after session summarization.

Export: extractPlansFromSession(userId, sessionId, messages): Promise<void>

Logic:
- Filter to last 20 user messages from the session
- Call Groq 8B with a focused prompt:

SYSTEM: You are extracting concrete plans from a conversation.
Return a JSON array of plans found (empty array if none).
Each plan: { text: string, type: "social"|"food"|"activity"|"study"|"travel"|"other",
             participants: string[], planned_for_raw: string | null,
             planned_for_iso: string | null }
Only extract CONCRETE plans with intent to actually do something.
NOT "I should try that someday" — only "let's go Saturday" or "we're planning X".

USER: [conversation text]

- For each extracted plan, insert into conversation_plans
- For planned_for_iso, trust the LLM's ISO string but validate it's a real future date
  (within 30 days from now). If invalid or past, set planned_for = null.
- Wrap in try/catch, log errors, never throw

STEP 3: Wire plan extraction into src/archivist/session-summaries.ts

In summarizeSession(), after Step 5 (writing to memories), add:
  // Step 6: Extract concrete plans from session for future stimulus pipeline
  setImmediate(async () => {
    try {
      const { extractPlansFromSession } = await import('../intelligence/plan-extractor.js')
      await extractPlansFromSession(userId, sessionId, messages)
    } catch (err) {
      log.error({ err, sessionId }, 'Plan extraction failed')
    }
  })

STEP 4: Extend collectTopicFollowup in src/sentinel/collectors.ts

After the existing topic_intents query, add a second query for upcoming plans:

  SELECT plan_id, plan_text, plan_type, participants, planned_for, planned_for_raw
  FROM conversation_plans
  WHERE user_id = $userId
    AND status = 'pending'
    AND planned_for > NOW()
    AND planned_for <= NOW() + INTERVAL '48 hours'
  ORDER BY planned_for ASC
  LIMIT 2

For each upcoming plan, create a StimulusInput:
  {
    type: 'plan_reminder',
    key: `plan_reminder_${plan.plan_id}`,
    weight: 0.80,  // plan reminders are high-value
    data: {
      message: `Reminder: "${plan.plan_text}" is coming up (${plan.planned_for_raw})`,
      suggestedAction: 'Check in about the plan',
      hashtag: '#plan_reminder',
      priority: 'high',
      planId: plan.plan_id,
      planType: plan.plan_type,
      participants: plan.participants,
      raw: plan,
    }
  }

After firing a plan reminder stimulus, mark it as 'reminded':
  UPDATE conversation_plans SET status = 'reminded' WHERE plan_id = $planId

WRITE TESTS:
- "plan-extractor: extracts 'grab coffee Saturday' as social plan"
- "plan-extractor: ignores vague statements like 'we should do that someday'"
- "collectTopicFollowup: returns plan_reminder stimulus for plan due in 24h"
- "collectTopicFollowup: ignores plans already marked 'reminded'"
```

---

### PROMPT M2: Build Weekly Digest Pipeline
**Files:** `database/migrations/012-weekly-digest.sql`, `src/archivist/weekly-digest.ts`, `src/sentinel/collectors.ts`
**Effort:** 3–4 days

```
You are working in the personifi-aria TypeScript codebase.

TASK: Build the weekly digest pipeline that compresses the week's activity into a
structured summary, updates the social graph, and archives old raw data.

STEP 1: Create database/migrations/012-weekly-digest.sql

CREATE TABLE IF NOT EXISTS weekly_digests (
    digest_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    week_start          DATE NOT NULL,                 -- Monday of the week (IST)
    week_end            DATE NOT NULL,                 -- Sunday of the week (IST)
    summary_text        TEXT NOT NULL,                 -- 3-5 sentence narrative
    key_topics          JSONB DEFAULT '[]',            -- [{ topic, count, category }]
    plans_made          JSONB DEFAULT '[]',            -- plans created this week
    plans_completed     JSONB DEFAULT '[]',            -- plans that resolved positively
    plans_unresolved    JSONB DEFAULT '[]',            -- plans that didn't happen
    social_activity     JSONB DEFAULT '{}',            -- { personName: interactionCount }
    preferences_updated JSONB DEFAULT '[]',            -- preferences confirmed/discovered
    mood_trend          VARCHAR(20),                   -- 'positive' | 'neutral' | 'stressed'
    pulse_avg           NUMERIC(5,2),                  -- average pulse score for the week
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS weekly_digests_user_week_idx
    ON weekly_digests (user_id, week_start);

CREATE INDEX IF NOT EXISTS weekly_digests_user_recent_idx
    ON weekly_digests (user_id, week_start DESC);

STEP 2: Create src/archivist/weekly-digest.ts

Export: runWeeklyDigestForAllUsers(): Promise<void>
Export: runWeeklyDigestForUser(userId: string, weekStart: Date): Promise<void>

runWeeklyDigestForUser logic:
1. Get all session_summaries for user in the past 7 days (between weekStart and weekEnd)
2. Get all conversation_plans created in the week
3. Get pulse_history entries for the week (average score, state distribution)
4. Call Groq 8B with:

SYSTEM: You are Aria's weekly memory consolidator for a college student.
Given session summaries from this week, produce a structured weekly digest.
Return ONLY valid JSON matching this schema:
{
  "summary_text": "3-5 sentence narrative of the week",
  "key_topics": [{ "topic": string, "count": number, "category": string }],
  "social_activity": { "personName": interactionCount },
  "preferences_updated": [{ "category": string, "value": string, "confidence": "high"|"medium" }],
  "mood_trend": "positive"|"neutral"|"stressed",
  "plans_unresolved": [{ "plan_text": string, "reason": "never_discussed" }]
}

USER: Week of [dates]. Session summaries: [summaries joined].
Plans made this week: [plan_text list].
Plans marked unresolved: [unresolved plan_text list].

5. Insert the weekly_digest record
6. For each preference in preferences_updated with confidence "high":
   - UPSERT into user_preferences
7. For each name in social_activity with count >= 2:
   - Look up user_relationships for a matching friend name
   - If found: increment bond_strength by log(count) (small boost, logarithmic)
8. Mark all conversation_plans in the week older than 48h and still 'pending' or 'reminded'
   as 'unresolved' (the plan date passed without resolution)
9. Archive session raw messages older than 7 days to S3 via archiveSession(),
   then DELETE from sessions table (keep session_summaries)

runWeeklyDigestForAllUsers:
- Find all users who had at least 3 session_summaries in the past 7 days
- Check they don't already have a digest for this week
- Call runWeeklyDigestForUser for each (with rate limiting — max 5 concurrent)

STEP 3: Wire into Sentinel maintenance

In src/sentinel/collectors.ts, add a new maintenance function:
  export async function runWeeklyDigest(): Promise<void>
  - Check if today is Monday and current IST hour is between 2–4 AM
  - If yes, call runWeeklyDigestForAllUsers()

In src/sentinel/sentinel-loop.ts, add to the maintenance phase:
  if (tickCount % (7 * 24 * 60) === 0) {  // approximately weekly
    await runWeeklyDigest().catch(err => log.error({ err }, 'Weekly digest error'))
  }

Actually better: use a specific time check. Add to the maintenance phase:
  // Weekly digest: runs Monday 2–4 AM IST
  const istHour = getISTHour(new Date())
  const istDay = getISTDayOfWeek(new Date())  // 0=Sun, 1=Mon
  if (istDay === 1 && istHour >= 2 && istHour < 4 && tickCount % 60 === 1) {
    await runWeeklyDigest().catch(err => log.error({ err }, 'Weekly digest error'))
  }

STEP 4: Add weekly_summary collector

In collectTopicFollowup (or a new function collectWeeklySummary), query the most
recent weekly_digest for the user and check plans_unresolved. For each unresolved plan
older than 3 days, generate a gentle stimulus:
  "Hey, that [plan_text] with [participants] from last week — did that ever happen?"

This gives Aria natural continuity across weeks without storing raw messages.

WRITE TESTS:
- "weekly-digest: generates digest from 3 session summaries"
- "weekly-digest: marks pending plans as unresolved after plan date"
- "weekly-digest: updates user_preferences from high-confidence preferences_updated"
- "weekly-digest: skips if digest already exists for this week"
- "weekly-digest: unresolved plan surfaces as stimulus after 3 days"
```

---

### PROMPT M3: Timestamp-Gated Context Loading in Alpha
**File:** `src/alpha/context-manager.ts`
**Effort:** 2 hours

```
You are working in the personifi-aria TypeScript codebase.

PROBLEM:
src/alpha/context-manager.ts loads session_summaries for context without any
recency weighting. A summary from 6 days ago is treated the same as one from
6 hours ago.

TASK: Add timestamp-aware recency scoring when loading session summaries.

In the function that loads session_summaries for the context window:

1. Add a recency multiplier to each summary's relevance score:
   const ageHours = (Date.now() - summary.created_at.getTime()) / 3600000
   const recencyMultiplier = ageHours < 24 ? 1.0      // today
                           : ageHours < 48 ? 0.85     // yesterday
                           : ageHours < 72 ? 0.70     // 2 days ago
                           : ageHours < 168 ? 0.50    // this week
                           : 0.25                      // older

   finalScore = vectorSimilarity * recencyMultiplier

2. Sort by finalScore DESC, take top 5

3. When building the context section, prepend a timestamp label:
   "[Today]", "[Yesterday]", "[2 days ago]", "[This week]" based on ageHours

4. Also: when loading weekly_digest (once that table exists), inject the most
   recent weekly_digest summary_text into the context as a "Memory: Last week"
   section — budget 200 tokens for this, placed between preferences and session_summaries.

No new tests needed — but update context-manager.test.ts if it exists to verify
the recency multiplier logic.
```

---

## Part 3 — Alpha Wiring (Critical Architecture)

---

### PROMPT A1: Wire Alpha Under Feature Flag
**Files:** `src/character/handler-router.ts`, `src/character/handler.ts`, `src/alpha/alpha-caller.ts`
**Effort:** 2–3 days (with staging validation)

```
You are working in the personifi-aria TypeScript codebase.

PROBLEM:
src/alpha/alpha-caller.ts has a complete, production-quality 5-step pipeline
(NLU → Tool Calling → Response Gen → Signal Write → Context Management) but
src/character/handler.ts still drives production via the legacy 22-step pipeline
and generateResponse() via tierManager.ts.

handler-router.ts is currently just a passthrough re-export:
  export { handleMessage } from './handler.js'

The original handler-alpha.ts and handler-legacy.ts were deleted prematurely,
leaving no feature-flag toggle.

TASK: Restore the feature-flag toggle and wire callAlpha() as the alpha path.

STEP 1: In src/character/handler-router.ts, restore the router pattern:

import { handleMessage as handleMessageLegacy } from './handler.js'
import { handleMessage as handleMessageAlpha } from './handler-alpha.js'

const ALPHA_HANDLER_ENABLED = process.env.ALPHA_HANDLER_ENABLED === 'true'

export const handleMessage = ALPHA_HANDLER_ENABLED
    ? handleMessageAlpha
    : handleMessageLegacy

STEP 2: Create src/character/handler-alpha.ts

This is the new slim handler. It should:
1. Run Steps 1-3 from the legacy handler (sanitize, getOrCreateUser, rate limit)
2. Load session and pulse state (Step 4)
3. Call callAlpha() from src/alpha/alpha-caller.ts
4. Run post-processing: appendMessages, pulseService.logTurn, topicIntentService.updateFromTurn
5. Return the response

Copy the minimum necessary from handler.ts. Do NOT re-implement the 22-step pipeline.
callAlpha() already handles: context loading, tool execution (via tool-sandbox),
LLM call (with failover), signal writing.

STEP 3: Set ALPHA_HANDLER_ENABLED=false in .env.example
Add to .env.example:
  # Alpha handler: set to 'true' to use the new 5-step Alpha pipeline instead of legacy 22-step
  # Test thoroughly before enabling in production
  ALPHA_HANDLER_ENABLED=false

STEP 4: Smoke test
- Run the bot locally with ALPHA_HANDLER_ENABLED=true
- Send 5 messages: a simple question, a food query, a tool-needing query,
  a rejection of a suggestion, a follow-up
- Confirm: responses are coherent, pulse updates, session history written, no errors

IMPORTANT: Do NOT delete handler.ts until after 72 hours of production burn-in
with ALPHA_HANDLER_ENABLED=true.
```

---

## Summary: Execution Order

| Priority | Prompt | Effort | Impact |
|----------|--------|--------|--------|
| P0-A | Fix IST bug | 20 min | Fixes silent message drops |
| P0-B | Daily fatigue enforcement | 3h | Prevents spam |
| P0-C | Remove influence-engine | 1d | Eliminates conflicting decision layer |
| P1-A | Social overlay | 2d | Unlocks squad cascade — core feature |
| P1-B | Hydrate preferences in Sentinel | 3h | Fixes preference-blind scoring |
| P1-C | collectSocialMonitor | 2d | Social stimuli finally generated |
| P1-D | collectTopicFollowup | 4h | Warm topic re-engagement |
| P2-A | Fix tool threshold | 30min | PROACTIVE users get full tool access |
| P2-B | Integration tests reactive.ts | 1d | Critical path verified in CI |
| P2-C | committed_action signal | 2h | Pulse calibration fix |
| M1 | conversation_plans pipeline | 3d | Plans become future stimuli |
| M2 | Weekly digest pipeline | 4d | Long-term memory + 7-day cleanup |
| M3 | Timestamp-gated context | 2h | Recency-aware context loading |
| A1 | Wire Alpha under flag | 3d | Activates the full target architecture |

**Total estimated effort:** ~4–5 weeks for one developer.
**MVP cutoff (working product):** P0-A through P1-C (~1 week) gives you a system where
social intelligence actually works, preferences are applied, and the core behavior
(proactive → pushback → reactive → recovery) is fully functional.

---

## Conversational Multi-Message Behavior (Design Note)

Your storyboards show Aria sending 2-3 messages like a real person ("hey heads up —
rain's about to start. Rapido's ₹120 right now. Want me to book one?"). This is NOT
yet implemented — Alpha generates one response per turn.

**Design decision needed:** Add a response chunking layer in channels.ts that:
1. Detects natural break points in Alpha's output (double newline, sentence ending before a question)
2. Splits into 2-3 parts
3. Sends with 400–800ms delay between parts (simulate typing)

This should be a separate prompt once the core fixes above are merged. The prompt
would target `src/channels.ts` sendProactiveContent() and `src/alpha/alpha-caller.ts`
final output formatting.
```

