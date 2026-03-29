# Aria — Stimulus Architecture & Plan Lifecycle
**Status:** Design Document
**Date:** 2026-03-29

---

## The Core Problem This Document Solves

Right now, `src/stimulus/` and `src/tools/` are doing three different jobs without knowing it. The codebase needs a clean separation into three distinct concepts that currently exist but are conflated:

1. **Passive Stimuli** — environmental signals Aria observes to decide *when* to reach out
2. **Active Stimuli** — deal/opportunity signals from external services that are both a reason to message *and* carry a pre-packaged action payload
3. **Workflow Tools** — things Aria executes *on behalf of the user* after they say yes

Getting this separation right is what enables the "intelligent friend" feel. The passive system decides to say "heavy rain's coming, Rapido surge is about to hit." The active stimulus system is what makes Aria say "Meghana's has 40% off biryani on Swiggy right now — that's your usual order." These are fundamentally different in both how they're sourced and how Alpha handles them.

---

## The Three-Layer Taxonomy

```
┌─────────────────────────────────────────────────────────┐
│               PASSIVE STIMULI (what Aria observes)       │
│                    src/stimulus/                         │
│                                                          │
│  weather · traffic · festival · mess-menu               │
│  local-event · social-convergence · topic-followup      │
│  plan-reminder · interest-intent                         │
│                                                          │
│  → Sentinel scores these → decides FIRE/BUFFER/DROP      │
│  → Alpha delivers the message                            │
│  → User responds → Aria replies                          │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│      ACTIVE STIMULI (opportunities from live services)   │
│               src/active-stimulus/  ← NEW               │
│                                                          │
│  food-deals · grocery-deals · ride-surge                 │
│  event-tickets · campus-offers                           │
│                                                          │
│  → Sentinel polls these on a slower cadence             │
│  → Each carries a workflowPayload (pre-packaged args)   │
│  → Alpha delivers: "Meghana's 40% off — want it?"       │
│  → User says "yes" → Alpha calls workflow immediately   │
│  → No additional parameter-gathering needed             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│          WORKFLOW TOOLS (Aria acts for user)             │
│                    src/tools/                            │
│                                                          │
│  ride-compare · food-compare · grocery-compare          │
│  swiggy-mcp · blinkit-mcp · zepto-mcp · travel-mcp     │
│  places · weather · directions · flights · hotels       │
│                                                          │
│  → Alpha calls these reactively (user asks)             │
│  → OR Alpha calls these from active-stimulus payload    │
│  → Result formatted and returned to user                │
└─────────────────────────────────────────────────────────┘
```

### Why the Current `suggestedAction` String Is Not Enough

`stimulus-router.ts` currently has things like:
```
suggestedAction: 'search_food_delivery'
suggestedAction: 'search_cafes_ac'
```

These are opaque strings. Alpha doesn't know what parameters to use. When weather triggers a "rain → order food" proactive message, there's no pre-packaged `{ tool: 'food_finder', args: { query: '...', location: '...' } }` — Alpha has to ask the user follow-up questions.

Active stimuli fix this. They carry a `workflowPayload` that is immediately executable:
```typescript
{
  type: 'food_deal',
  message: "Meghana's has 40% off biryani on Swiggy until 8pm",
  workflowPayload: {
    tool: 'food_finder',
    args: { query: 'biryani', restaurant: "Meghana Foods", location: 'user_home' }
  }
}
```
When the user says yes, Alpha executes `workflowPayload` without another round-trip.

---

## Part 1 — Passive Stimulus Expansion

### What Already Exists
| Stimulus | Source | State | Issues |
|---|---|---|---|
| `weather` | OpenWeatherMap | In-memory, 30-min refresh | No composite scoring with commute |
| `traffic` | Google Maps | In-memory, 30-min refresh | No per-user route model |
| `festival` | Static calendar | In-memory | College-specific festivals not covered |
| `mess_menu` | OCR → DB | DB-backed | Good |
| `local_event` | DB | DB-backed | No external event source yet |

### What Needs to Be Added

**`social-convergence` stimulus** — already architecturally designed but implemented as a stub in `collectSocialMonitor()`. See `AGENT_FIX_PROMPTS.md` Prompt P1-A.

**`topic-followup` stimulus** — stub in `collectTopicFollowup()`. See `AGENT_FIX_PROMPTS.md` Prompt P1-D.

**`plan-reminder` stimulus** — NEW. Surfaces upcoming plans from `conversation_plans` table. See below.

**`interest-intent` stimulus** — NEW. Surfaces things the user showed passive interest in within the past 7 days. This is *different* from `plan-reminder` (see plan lifecycle section).

### The interest-intent Stimulus

When a user says "I've been meaning to try that ramen place" or "we should check out that new café" — they haven't committed to a plan. It's an interest signal. The lifecycle for this is:

```
User expresses interest → topic_intents record created (phase: EMERGING/BUILDING)
                       ↓
Within 7 days → collectTopicFollowup generates stimulus (once)
                       ↓
Aria surfaces it: "btw did you ever try that ramen place you mentioned?"
                       ↓
User responds → two outcomes:
  RESOLVED: "yeah we went, was amazing" → mark topic STABLE, extract to memory
  UNRESOLVED: "nah not yet" → mark CURIOUS, give one more week
                       ↓
After 7 days with no resolution → topic moves to weekly_digest → removed from hot pool
```

**Key rule: surface once per 7-day window, not repeatedly.** A topic_intent last surfaced as a stimulus should have a `last_surfaced_at` timestamp. Don't re-surface for 7 days.

---

## Part 2 — Active Stimulus System (New)

### The Concept

Active stimuli are different from passive stimuli in one critical way: **they come from external commercial services that have their own timing and deals.** You can't predict when Swiggy will run a flash sale. You poll for them.

When an active stimulus fires, the user experience should be:

> Aria (proactive): "Hey, Meghana's is doing 40% off biryani on Swiggy right now — closes at 8pm. That's basically ₹80 off your usual order. Want me to pull it up?"
> User: "yes go"
> Aria: [immediately calls `food_finder` with pre-packaged args → returns order link]

No back-and-forth about what restaurant, what platform, what location. It's already packaged.

### Architecture: `src/active-stimulus/`

Create a new directory `src/active-stimulus/` with:

```
src/active-stimulus/
  types.ts              -- ActiveStimulusInput type (extends StimulusInput with workflowPayload)
  food-deals.ts         -- Swiggy/Zomato offers for user's frequent restaurants
  grocery-deals.ts      -- Blinkit/Zepto flash deals on user's frequent items
  ride-surge.ts         -- Rapido/Ola surge pricing (alert user BEFORE surge hits)
  event-tickets.ts      -- Campus event ticket availability
  index.ts              -- collectActiveStimuliForUser(userId) aggregator
```

### The `ActiveStimulusInput` Type

```typescript
// src/active-stimulus/types.ts
export interface WorkflowPayload {
  /** The Alpha tool name to call when user accepts */
  tool: string
  /** Pre-packaged arguments — ready to execute immediately */
  args: Record<string, unknown>
  /** Human-readable CTA for Alpha to use */
  ctaText: string
}

export interface ActiveStimulusInput {
  type: 'food_deal' | 'grocery_deal' | 'ride_surge' | 'event_ticket' | 'campus_offer'
  key: string
  weight: number
  /** The proactive message Aria should send */
  message: string
  /** Pre-packaged workflow — executes immediately when user says yes */
  workflowPayload: WorkflowPayload
  /** When this deal/opportunity expires */
  expiresAt: Date | null
  /** Source platform */
  source: 'swiggy' | 'zomato' | 'blinkit' | 'zepto' | 'rapido' | 'campus'
  data: Record<string, unknown>
}
```

### `food-deals.ts` — Swiggy/Zomato Offers for User's Frequent Restaurants

**Data Source:** Query user's `memories` table for frequently mentioned restaurants + their order history hints. Then call Swiggy/Zomato to check current offers for those specific restaurants.

**Polling cadence:** Every 2 hours (120 ticks in Sentinel). Deals change frequently.

**Logic:**
1. Get user's top 5 frequent restaurants from memories + preferences
2. For each restaurant, call Swiggy MCP `get_offers` (or scrape the restaurant page)
3. For each offer with discount >= 30%, generate an `ActiveStimulusInput`:
   - weight: 0.70 (high — personalized deal)
   - message: `"${restaurant} has ${discount}% off ${item} on Swiggy until ${time}"`
   - workflowPayload: `{ tool: 'food_finder', args: { query: item, restaurant, location: user_home } }`
4. Deduplicate: don't fire the same restaurant deal twice in 4 hours

**Scoring note:** The weight here is already high (0.70) because the deal is personalized to *their* restaurants. Social overlay (`collectSocialMonitor`) can push it higher if squad members also ordered there recently.

### `grocery-deals.ts` — Blinkit/Zepto Flash Deals

**Data Source:** User's frequently bought grocery items from memories/preferences. Then poll Blinkit/Zepto for current prices vs. typical prices.

**Logic:**
1. Get user's top grocery items (milk, eggs, bread — college staples) from preferences
2. Poll Blinkit + Zepto prices
3. If current price is 20%+ below typical price → generate stimulus
4. workflowPayload: `{ tool: 'price_alert', args: { query: item, location: user_home } }`

**Polling cadence:** Every 3 hours. College students are price-sensitive; flash deals matter.

### `ride-surge.ts` — Rapido/Ola Surge Alert (Preventive)

This is fundamentally different from the others — it's a NEGATIVE stimulus. The user doesn't want surge pricing. Aria's job is to alert them *before* surge hits so they can book now at normal price.

**Data Source:** Current Rapido/Ola API pricing for user's home → college route.

**Logic:**
1. During morning window (7:30am–9:30am IST) and evening window (5:30pm–8pm IST):
   - Poll ride pricing for user's commute route
   - Compare to typical price from `user_preferences` (category: `typical_ride_cost`)
2. If current price is within 20% of typical but the time is a known surge window:
   - "Rapido is ₹120 right now (normal price). Surge usually kicks in 8:30am. Book in the next 15 mins to avoid it."
   - workflowPayload: `{ tool: 'cab_compare', args: { pickup: user_home, destination: college } }`
3. If surge is already active:
   - "Surge is on — Rapido is ₹185 right now. Might be worth waiting 30 mins or taking the shuttle."

**Important:** Don't fire this if user already booked a cab today (check `memories` for "booked rapido" pattern).

**Polling cadence:** Every 15 ticks (15 min) during commute windows only. No polls at 2pm.

### `event-tickets.ts` — Campus Event Ticket Availability

**Data Source:** The `local_events` table (existing) + ticket availability polling for events the user's squad has expressed interest in.

**Logic:**
1. Find local events where: user has interest match AND event is in next 3 days AND tickets are available
2. If squad members (from squad_intents) are also interested in the same event → boost
3. workflowPayload: `{ tool: 'event_lookup', args: { query: eventName, location: campus, date: eventDate } }`

**This is the storyboard scenario** — "comedy show at BLR Brewing, Rahul + Priya already got tickets." The event ticket stimulus detects ticket availability + squad interest → fires proactive message.

### Wiring Active Stimuli into Sentinel

In `src/sentinel/collectors.ts`, add:

```
export async function collectActiveStimuli(userId: string): Promise<StimulusInput[]>
```

This calls `src/active-stimulus/index.ts` and returns `ActiveStimulusInput[]` cast to `StimulusInput[]` (they're compatible — `ActiveStimulusInput` extends the shape).

In `sentinel-loop.ts`, add to `collectorMap`:
```
{ key: 'active_stimuli', category: 'active_stimulus', fn: collectActiveStimuli }
```

Polling interval: every 30 ticks (30 minutes). Slower than social (15 ticks) because commercial deals don't change every minute.

### Wiring Workflow Payload into Alpha

When Alpha receives a FIRE decision that came from an active stimulus, the `ProactiveStateRow` written to the DB should include `workflowPayload` in its `stimulus_data` JSONB field. This already exists architecturally — `ProactiveStateRow.stimulus_data` is `JSONB`.

In `src/fusion/reactive.ts`, when injecting buffered context:
- Check if the `ProactiveStateRow` has `stimulus_data.workflowPayload`
- If yes, add to Alpha's context: `"If user accepts, immediately call tool: ${workflowPayload.tool} with args: ${JSON.stringify(workflowPayload.args)}"`
- This is a system-level instruction, not a user message

In `src/alpha/alpha-prompt-builder.ts`, add a section for `actionableContext`:
```
// Actionable context (from active stimuli) — execute immediately if user accepts
if (proactiveState?.workflowPayload) {
  sections.push(`[READY ACTION]: If user agrees, call ${workflowPayload.tool}(${JSON.stringify(workflowPayload.args)}). CTA: "${workflowPayload.ctaText}"`)
}
```

---

## Part 3 — Plan Lifecycle (The 1-Week Window)

### The Complete Plan Lifecycle

```
DETECTION (in conversation):
  User says "let's grab coffee this Saturday" or "we should check out that ramen place"
                     ↓
CLASSIFICATION:
  is_concrete_plan? (specific time + participants + activity)
    YES → conversation_plans (planned_for date known)
    NO  → topic_intents (interest signal only, no date)
                     ↓
━━━━━━━━━━━━━━━━━━ FOR CONCRETE PLANS ━━━━━━━━━━━━━━━━━━

WITHIN 24-48 HOURS BEFORE planned_for:
  collectTopicFollowup generates plan_reminder stimulus
  Aria: "By the way, your coffee thing with Priya is tomorrow — still on?"
  → Mark plan as 'reminded'
                     ↓
ON/AFTER planned_for DATE:
  Check for resolution signals in recent conversation:
    RESOLVED → mark COMPLETED, extract memory:
               "User went for coffee with Priya at Café Theory (mentioned it was good)"
               → Write to memories + update social graph bond
    NOT RESOLVED after 48h → mark UNRESOLVED
                     ↓
UNRESOLVED PLAN (within the following week):
  Weekly digest pipeline surfaces it ONCE as a gentle stimulus:
  Aria: "That coffee plan with Priya from last week — did it ever happen?"
  → If yes: extract memory, mark COMPLETED, done
  → If no: mark ARCHIVED, goes into weekly digest, never surfaces again as a stimulus

CLEANUP:
  After 7 days from creation (regardless of status), plan exits the hot stimulus pool
  Unresolved plans live in weekly_digest.plans_unresolved as compact records
  They influence Aria's understanding ("Priya and user had an unfulfilled plan → mention it naturally")
  but don't generate further stimuli

━━━━━━━━━━━━━━━━━━ FOR INTEREST INTENTS ━━━━━━━━━━━━━━━━━━

WITHIN 7 DAYS of topic_intents creation:
  collectTopicFollowup generates topic_followup stimulus (once per 7-day window)
  Aria: "Did you ever try that ramen place you mentioned?"
  → Tracks this in topic_intents.last_surfaced_at
                     ↓
USER RESPONSE:
  "yeah we went" → phase → STABLE, extract memory, done
  "nah not yet" → phase → CURIOUS, last_surfaced_at reset, give another 7-day window
  No response / no conversation → after 7 days from creation → phase → ABANDONED
                     ↓
CLEANUP:
  ABANDONED topics exit after 7 days
  Included in weekly_digest.key_topics (low-signal entry)
  Never re-surface as stimuli
```

### The Key Rule: 1-Week Maximum Residency

No plan or interest intent stays in the active stimulus pool for more than 7 days from creation. This prevents:
- Stale "did you try that ramen place?" messages months after the user forgot
- Stimulus pool growing unboundedly
- Aria feeling like she's nagging

After 7 days:
- Concrete plans → `UNRESOLVED` or `COMPLETED` → weekly_digest
- Interest intents → `ABANDONED` or `STABLE` → weekly_digest + memories
- Raw conversation data → S3 archive

### Database Schema Changes Needed

**Modify `topic_intents` table** (existing):
```sql
ALTER TABLE topic_intents ADD COLUMN IF NOT EXISTS last_surfaced_at TIMESTAMPTZ;
ALTER TABLE topic_intents ADD COLUMN IF NOT EXISTS surface_count INTEGER DEFAULT 0;
```

`last_surfaced_at` prevents surfacing the same topic twice in a 7-day window.
`surface_count` caps at 2 — if Aria has surfaced a topic twice and it's still unresolved, it gets archived regardless of age.

**The `conversation_plans` table** — see `AGENT_FIX_PROMPTS.md` Prompt M1 for full schema.

### Plan Resolution Detection

Plan resolution detection happens in two places:

**1. Real-time (in conversation) — Alpha's signal writer**

In `src/alpha/alpha-caller.ts` (the Signal Write step), after each turn:
- Check if any `conversation_plans` are in `pending` or `reminded` state with `planned_for` in the past 48 hours
- Run a lightweight pattern check on the user's message: did they mention completing the plan?
  - Positive patterns: "yeah we went", "went there yesterday", "ended up going", "it happened"
  - Negative patterns: "didn't end up going", "it got cancelled", "we skipped it"
- If positive → mark COMPLETED + extract memory (via archivist queue)
- If negative → mark UNRESOLVED immediately (don't wait for timeout)

This is a keyword/pattern check, not an LLM call. No extra token cost.

**2. Periodic (weekly) — sentinel maintenance**

The weekly digest pipeline (Prompt M2) does a final sweep: any plans older than 48 hours post-`planned_for` that are still `pending` or `reminded` → mark UNRESOLVED. These get included in the weekly digest's `plans_unresolved` field.

---

## Part 4 — External API Wiring for Stimuli

### Current State of External APIs

| Service | Current Usage | Stimulus Usage | Gap |
|---|---|---|---|
| OpenWeatherMap | ✅ weather-stimulus.ts | Passive only | No: rain timing prediction |
| Google Maps | ✅ traffic-stimulus.ts | Passive only | No: per-user route model |
| Swiggy (MCP + scraper) | ✅ tools only | None | Need: offers polling |
| Zomato (MCP + scraper) | ✅ tools only | None | Need: offers polling |
| Blinkit (scraper) | ✅ tools only | None | Need: flash deal detection |
| Zepto (scraper) | ✅ tools only | None | Need: flash deal detection |
| Rapido/Ola/Uber | ✅ ride-compare.ts | None | Need: surge alert stimulus |
| Amadeus | ✅ flights | None | N/A for college-first |
| Festival calendar | ✅ static | Passive only | Need: college calendar |

### Where External API Wiring Goes

External API calls for stimulus purposes go in `src/active-stimulus/` not in `src/stimulus/`. The distinction:
- `src/stimulus/` = environmental/ambient (weather, traffic, campus events) — these are things Aria observes
- `src/active-stimulus/` = commercial opportunities (deals, surge pricing) — these require polling

### API Wiring Priorities for Active Stimulus

**Priority 1 — Rapido surge (ride-surge.ts)**
Already have `ride-compare.ts` in tools. Reuse the same API calls. The active stimulus version just runs the comparison at commute hours and checks if current price > typical price. No new API credentials needed.

**Priority 2 — Swiggy food deals (food-deals.ts)**
Requires: Swiggy MCP `get_restaurant_offers` method OR scraping the restaurant page directly for current offers. The MCP client already exists at `src/tools/mcp-client.ts`. Add `callMCPTool('swiggy-food', 'get_offers', { restaurant_id })`.

**Priority 3 — Blinkit/Zepto grocery deals (grocery-deals.ts)**
Requires: scraping product pages for items the user frequently buys. The scrapers exist (`src/tools/scrapers/blinkit.ts`, `zepto.ts`). The active stimulus version queries user preferences for frequent items, runs the scraper, compares against a stored "last seen price" in a new `price_history` table.

**The `price_history` Table (lightweight):**
```sql
CREATE TABLE IF NOT EXISTS price_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    item_key    VARCHAR(100) NOT NULL,  -- normalized product name
    platform    VARCHAR(30) NOT NULL,
    price       NUMERIC(8,2) NOT NULL,
    seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON price_history (user_id, item_key, platform, seen_at DESC);
```

This gives the system a baseline to compare against. If today's Blinkit milk price is 20% below the price seen 2 days ago — fire the stimulus.

---

## Part 5 — The Missing `StimulusType` Enum

Currently `stimulus-router.ts` defines:
```typescript
export type StimulusType = 'weather' | 'traffic' | 'festival' | 'food' | 'event'
```

This needs to expand significantly and be moved to `src/fusion/types.ts` (the central type registry) where all of Aria's architecture can reference it:

```typescript
// src/fusion/types.ts — replace the inline type string with:

export type PassiveStimulusType =
  | 'weather'
  | 'traffic'
  | 'festival'
  | 'mess_menu'
  | 'local_event'
  | 'social_convergence'   // squad members doing same thing
  | 'topic_followup'       // warm topic not discussed in 36h
  | 'plan_reminder'        // concrete upcoming plan
  | 'interest_intent'      // passive interest signal within 7-day window

export type ActiveStimulusType =
  | 'food_deal'            // Swiggy/Zomato offer on frequent restaurant
  | 'grocery_deal'         // Blinkit/Zepto flash deal on frequent item
  | 'ride_surge'           // Rapido/Ola surge alert
  | 'event_ticket'         // Campus/local event ticket availability
  | 'campus_offer'         // College-specific deals (library, cafeteria, merch)

export type StimulusType = PassiveStimulusType | ActiveStimulusType
```

The Sentinel scoring system (`computeFusionScore` in `fusion/scoring.ts`) should treat `ActiveStimulusType` stimuli with a higher base receptivity — they carry a pre-packaged action, so even a CURIOUS-mode user should see them (lower FIRE threshold for active stimuli with workflowPayload).

---

## Part 6 — The Correct File Structure

**What should move:**

```
CURRENT                          →  TARGET
─────────────────────────────────────────────────────────
src/stimulus/stimulus-router.ts     Keep, but simplify (remove mess-menu, local-event — they have their own files)
src/stimulus/weather-stimulus.ts    Keep
src/stimulus/traffic-stimulus.ts    Keep
src/stimulus/festival-stimulus.ts   Keep
src/stimulus/mess-menu-stimulus.ts  Keep (college-first, stays passive)
src/stimulus/local-event-stimulus.ts Keep

src/tools/ride-compare.ts           Keep in tools (reactive tool)
src/tools/swiggy-mcp.ts             Keep in tools (reactive tool)
src/tools/blinkit-mcp.ts            Keep in tools (reactive tool)
[etc for all tools]

NEW src/active-stimulus/types.ts           Active stimulus type definitions
NEW src/active-stimulus/food-deals.ts      Swiggy/Zomato offer polling
NEW src/active-stimulus/grocery-deals.ts   Blinkit/Zepto price watching
NEW src/active-stimulus/ride-surge.ts      Rapido/Ola surge detection
NEW src/active-stimulus/event-tickets.ts   Campus event availability
NEW src/active-stimulus/index.ts           collectActiveStimuliForUser() aggregator
```

**What should NOT move:** All `src/tools/` files stay where they are. They are the execution layer. They get called by Alpha, not by Sentinel.

---

## Summary: What Needs to Be Built (Agent Prompt Order)

### Immediate (aligns with AGENT_FIX_PROMPTS.md)
These are addressed in the existing prompt doc:
- Implement social overlay (P1-A)
- Implement collectTopicFollowup with interest intents (P1-D, extended)
- Add conversation_plans + plan_reminder (M1)

### New Work (not in previous prompt doc)

**PROMPT NEW-1: Create `src/active-stimulus/types.ts` and expand `StimulusType`**
- Define `ActiveStimulusInput` interface with `workflowPayload`
- Expand `StimulusType` enum in `fusion/types.ts`
- No business logic yet — just types

**PROMPT NEW-2: Implement `ride-surge.ts`**
- Reuse `ride-compare.ts` tool
- Add commute-window time check (7:30–9:30am, 5:30–8pm IST)
- Compare current price against `user_preferences.typical_ride_cost`
- Generate `ActiveStimulusInput` with workflowPayload for `cab_compare`
- Wire into `collectActiveStimuliForUser()`

**PROMPT NEW-3: Implement `food-deals.ts`**
- Query user's frequent restaurants from memories
- Poll Swiggy MCP for offers
- Generate `ActiveStimulusInput` for 30%+ deals
- Wire into `collectActiveStimuliForUser()`

**PROMPT NEW-4: Wire `workflowPayload` through Sentinel → ProactiveState → Alpha**
- Modify `ProactiveStateRow` insertion to include `workflowPayload` in `stimulus_data`
- Modify `alpha-prompt-builder.ts` to inject action context when payload present
- Test: active stimulus fires → user says yes → tool executes

**PROMPT NEW-5: Implement plan resolution detection in Alpha signal writer**
- In `alpha-caller.ts` signal write step, check for pending plans with `planned_for` in past 48h
- Pattern-match user message for resolution signals
- Mark COMPLETED or UNRESOLVED accordingly

**PROMPT NEW-6: Add `last_surfaced_at` + `surface_count` to topic_intents**
- Migration file
- Update `collectTopicFollowup` to check `last_surfaced_at` before generating stimulus
- Cap at 2 surfaces per topic, max 7-day interval

**PROMPT NEW-7: Implement `grocery-deals.ts` + `price_history` table**
- `price_history` schema migration
- Compare Blinkit/Zepto prices vs last-seen
- Generate `ActiveStimulusInput` for 20%+ price drops

---

## Architectural Decisions & Trade-offs

### Decision 1: Active stimuli in a new directory vs. inside `src/stimulus/`

**Chosen:** New directory `src/active-stimulus/`

**Why:** Passive stimuli are environmental observations. Active stimuli are commercial service integrations with different characteristics (polling cadence, deal expiry, workflow payloads). Mixing them would make the Sentinel scoring logic harder to reason about. The separate directory also makes it clear to any developer: "active-stimulus things are deals/opportunities from live services."

**Trade-off:** One more directory to manage. The `collectActiveStimuliForUser` aggregator in `index.ts` adds a small abstraction layer. Acceptable cost for clarity.

### Decision 2: workflowPayload in the stimulus vs. in the proactive message

**Chosen:** workflowPayload lives in the `ActiveStimulusInput` and propagates through `ProactiveStateRow.stimulus_data`

**Why:** The payload needs to survive from when Sentinel detects the deal (potentially an hour before Alpha uses it) to when the user responds. Storing it in the ProactiveStateRow's `stimulus_data` JSONB field is the most durable path. Alpha reads it from there.

**Trade-off:** Slight schema coupling between active-stimulus and fusion-tables. Acceptable because `stimulus_data` is already a flexible JSONB column designed for this.

### Decision 3: 7-day hard cutoff for plan/interest stimulus residency

**Chosen:** 7 days from creation, not from last interaction

**Why:** College life moves fast. A plan from 10 days ago is genuinely stale. Using creation timestamp (not last-interaction) prevents a pathological case where an interest intent stays alive forever because the user keeps mentioning it incidentally.

**Trade-off:** Some "slow-burn" interests get archived. User might mention wanting to visit a place, forget about it for 10 days, then mention it again — Aria won't have the old intent. This is acceptable because the new mention will create a fresh topic intent. Better than surfacing a 3-month-old "you mentioned wanting to try X" message.

### Decision 4: Plan resolution via pattern-match, not LLM call

**Chosen:** Keyword/pattern matching in the signal write step

**Why:** Token cost. Checking for plan resolution on every turn with an 8B LLM call would add ~200-500 tokens to every message. Pattern matching (`/\b(went|went there|ended up|turned out)\b/i`) catches 80% of cases at zero token cost. Edge cases (ambiguous resolution) get handled in the weekly digest pass.

**Trade-off:** Some false negatives (user says "yeah it was" in an ambiguous context might not match). Acceptable — unresolved plans just surface once more in the weekly follow-up and the user can clarify then.
