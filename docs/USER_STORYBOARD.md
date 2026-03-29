# Personifi-Aria — Complete User Storyboard
## Every flow from user message to database and back

---

## SYSTEM TOPOLOGY

```
USER (Telegram)
    │
    ▼
[Telegram Bot API]
    │
    ▼
[src/index.ts — Fastify webhook]
    │
    ├─► /webhook/telegram  → handleMessage()  [handler.ts]
    └─► /callback          → handleCallback() [callback-handler.ts]

BACKGROUND (every 60s)
[Sentinel Loop — sentinel-loop.ts]
    │
    ├─► Collectors (weather, traffic, social, plans, topics)
    ├─► Fusion scoring
    └─► FIRE → Telegram  /  BUFFER → proactive_state DB
```

---

## DATABASES INVOLVED

| Table | Written by | Read by |
|---|---|---|
| `users` | handler.ts | handler.ts, sentinel |
| `sessions` | handler.ts | handler.ts, archivist |
| `memories` | archivist queue | handler.ts (vector search) |
| `memory_graph` | archivist queue | handler.ts (graph search) |
| `user_preferences` | archivist queue | handler.ts, sentinel |
| `session_summaries` | session-summaries.ts | digest-compiler, plan-extractor |
| `conversation_plans` | plan-extractor.ts | collectPlanReminders() |
| `weekly_digests` | digest-compiler.ts | context-manager (DIGEST tier) |
| `topic_intents` | topic-intent service | collectTopicFollowup(), handler |
| `proactive_state` | sentinel delivery.ts | fusionReactiveDecision() |
| `signal_packets` | fusion/reactive.ts | collectSocialMonitor() |
| `pulse_engagement_scores` | pulse-service.ts | sentinel, handler |
| `pulse_history` | pulse-service.ts | analytics |
| `pushback_tracker` | fusion/pushback.ts | fusionProactiveDecision() |
| `proactive_funnels` | orchestrator.ts | handleFunnelReply() |
| `squad_members` | social/squad.ts | collectSocialMonitor() |
| `user_relationships` | social/friend-graph.ts | handler |
| `stimulus_cache` | stimulus-router.ts | sentinel collectors |
| `tool_results` | sentinel (PRE_FETCH) | fusionReactiveDecision() |
| `memory_write_queue` | enqueueMemoryWrite() | processMemoryWriteQueue() |
| `sentinel_mode` | sentinel state-store | sentinel loop |
| `agenda_goals` | agenda-planner.ts | handler |

---

## STORY 1 — FIRST MESSAGE (New User Onboarding)

**Trigger:** User sends first ever message to the bot.

```
User: "Hey"
```

### Step-by-step flow

```
1. Telegram → POST /webhook/telegram
2. handler.ts: sanitizeInput("Hey") → clean
3. getOrCreateUser() → INSERT users row, user.authenticated = false
4. handleOnboarding() → onboarding-flow.ts
   └─ Detects: no displayName, no homeLocation
   └─ Returns: step="ask_name", reply="Hey! I'm Aria 👋 What's your name?"
5. isObviouslySimple("hey") → true → getSimpleClassification()
   └─ skip_memory=true, skip_graph=true
6. fusionReactiveDecision() → no active stimuli → writes signal_packet
7. No tool routing (onboardingActive=true)
8. callAlpha() → Together AI (DeepSeek V3)
   └─ System prompt: soul-v2.md + onboarding hint
   └─ Response: "Hey! I'm Aria 👋 What's your name?"
9. appendMessages() → sessions table
10. enqueueMemoryWrite() → SKIPPED (isSimple=true)
11. Telegram sends response
```

**DB writes:** `users`, `sessions`, `signal_packets`

---

```
User: "I'm Rohan"
```

```
1. handleOnboarding() → step="ask_location"
   └─ extractNameCandidate("I'm Rohan") → "Rohan"
   └─ updateUserProfile(userId, "Rohan", null)
2. callAlpha() → "Nice to meet you Rohan! Where are you based?"
3. DB: users.display_name = "Rohan"
```

---

```
User: "Bangalore"
```

```
1. handleOnboarding() → step="ask_preferences" (buttons: veg/non-veg/both)
2. extractLocationCandidate("Bangalore") → "Bangalore"
3. updateUserProfile(userId, null, "Bangalore")
4. user.authenticated = true after both name + location set
5. Step 8e fires: onboardingJustCompleted=true
   └─ executeAlphaTool("search_places", {query:"trending cafes", location:"Bangalore"})
   └─ toolResultStr = places data + proactive hint
6. callAlpha() → "Welcome to Bangalore Rohan! Here are some spots..."
7. DB: users.home_location = "Bangalore"
```

**DB writes:** `users`, `sessions`, `memories` (via queue)

---

## STORY 2 — REACTIVE CONVERSATION (Tool Use)

**Trigger:** Authenticated user asks for places.

```
User: "Good biryani places near Indiranagar?"
```

```
1. sanitizeInput() → clean
2. getOrCreateUser() → existing user, authenticated=true
3. checkRateLimit() → within limit
4. getOrCreateSession() → existing session
5. isObviouslySimple() → false → getDefaultClassification()
   └─ message_complexity="moderate", skip_memory=false
6. 6-way Promise.all:
   ├─ scoredMemorySearch(userId, "biryani indiranagar", 5)
   │   └─ pgvector cosine search → memories table
   │   └─ recency weighted: <24h=1.0, 1-3d=0.7, 3-7d=0.4
   ├─ searchGraph(userId, "biryani indiranagar", 2, 10)
   │   └─ memory_graph table → entity relationships
   ├─ loadPreferences(pool, userId)
   │   └─ user_preferences table → {diet:"vegetarian", ...}
   ├─ getActiveGoal(userId, sessionId)
   │   └─ agenda_goals table
   ├─ agendaPlanner.getStack()
   │   └─ agenda_goals table
   └─ pulseService.getState(userId)
       └─ pulse_engagement_scores (in-memory hot cache)

7. fusionReactiveDecision():
   ├─ getActiveProactiveState() → proactive_state table
   ├─ detectDirectionMismatch() → no stale stimuli
   ├─ buildSignalPacket() → extractTopicFromMessage("biryani") → "biryani"
   └─ insertSignalPacket() → signal_packets table
       └─ current_direction = "biryani"

8. brainHooks.routeMessage() → {useTool:true, toolName:"search_places",
                                 toolParams:{query:"biryani", location:"Indiranagar"}}

9. shouldRequestLocation() → user has homeLocation → skip

10. executeAlphaTool("search_places", args, userId):
    └─ tool-sandbox.ts validates args
    └─ tools/places.ts → Google Places API
    └─ Returns: [{name:"Meghana Foods", address:..., lat:..., lng:...}, ...]
    └─ toolResultStr = formatted places text
    └─ toolRawData = raw places array

11. Step 8c: search_places hint appended to toolResultStr
    └─ buildSearchPlacesContextHint() → get_weather tool call for Indiranagar
    └─ Appends weather + traffic context hint

12. composeSystemPrompt():
    └─ soul-v2.md (500 tokens)
    └─ user context: name, location, preferences (1000 tokens)
    └─ memories: "User likes biryani, went to Meghana last month" (300 tokens)
    └─ graph: "Rohan → likes → Meghana Foods" (200 tokens)
    └─ tool results: places data (800 tokens)

13. fusionOutput.contextAdditions injected into systemPrompt
    └─ (empty this turn — no active proactive stimuli)

14. callAlpha({userId, userMessage, history, preferences, memories,
               proactiveState: null, toolResult: toolResultStr}):
    └─ AlphaProvider.chatWithTools() → Together AI DeepSeek V3
    └─ toolResult already provided → Call 1 sees it in context
    └─ Model generates response (no second tool call needed)
    └─ Returns: "Meghana Foods in Indiranagar is legendary for biryani..."

15. extractVenuesFromToolResult() → venue pins [{lat, lng, name}]
16. selectInlineMedia() → reelPipeline → Instagram reel of Meghana Foods

17. filterOutput() → clean
18. appendMessages() → sessions table
19. trimSessionHistory() → keep last 20 messages
20. trackUsage() → usage_logs table

21. setImmediate (fire-and-forget):
    ├─ topicIntentService.processMessage()
    │   └─ Detects "biryani" topic → INSERT topic_intents
    │   └─ phase="active", strategy="standard"
    ├─ pulseService.recordEngagement()
    │   └─ extractEngagementSignals() → desire=+10 (user asked for something)
    │   └─ UPDATE pulse_engagement_scores
    │   └─ INSERT pulse_history
    └─ agendaPlanner.evaluate()
        └─ UPDATE agenda_goals

22. enqueueMemoryWrite() (non-simple message):
    ├─ ADD_MEMORY: "User asked for biryani in Indiranagar"
    ├─ GRAPH_WRITE: entity extraction → "Rohan → interested_in → biryani"
    ├─ SAVE_PREFERENCE: detect food preference signals
    └─ UPDATE_GOAL: session goal = "find food"

23. Response returned:
    └─ text: "Meghana Foods in Indiranagar..."
    └─ venues: [{name:"Meghana Foods", lat:12.97, lng:77.64}]
    └─ media: [{type:"video", url:"instagram_reel_url"}]
    └─ burstParts: split into 2 messages with typing delays
```

**DB writes:** `sessions`, `signal_packets`, `topic_intents`, `pulse_engagement_scores`, `pulse_history`, `agenda_goals`, `memory_write_queue`
**DB reads:** `memories`, `memory_graph`, `user_preferences`, `agenda_goals`, `pulse_engagement_scores`, `proactive_state`
**External APIs:** Google Places, Google Weather, Instagram (media)

---

## STORY 3 — STORYBOARD 1: THE FRIEND WHO REMEMBERS

**Trigger:** User mentions a future plan in conversation.

```
User (Sunday): "I'm so stressed, I have my final placement interview with Google on Thursday"
```

### Reactive path (same as Story 2 steps 1-22)

Additional step after session ends (30 min inactivity):

```
SENTINEL TICK (every 5 min) → runSessionCleanup() → checkAndSummarizeSessions():
    └─ Finds session inactive > 30 min with ≥ 4 messages
    └─ generateSummary() → Bedrock Claude Haiku (primary) / Groq 8B (fallback)
        └─ "User mentioned stress about Google placement interview on Thursday.
            They are anxious about the outcome."
    └─ embed(summaryText) → pgvector embedding
    └─ INSERT session_summaries (summary_text, vector, message_count)
    └─ addMemories() → memories table (searchable)
    └─ extractPlansFromSummary() [fire-and-forget]:
        └─ buildExtractionPrompt() → injects today's date (Sunday 2026-03-29 IST)
        └─ generateResponse() → LLM extracts:
            {
              plans: [{
                plan_type: "event",
                description: "Google placement interview",
                scheduled_for: "2026-04-02",  ← resolved from "Thursday"
                participants: []
              }],
              has_topic_interest: false
            }
        └─ INSERT conversation_plans:
            (user_id, plan_type="event", description="Google placement interview",
             scheduled_for="2026-04-02", status="pending",
             expires_at=NOW()+7days)
```

**Wednesday evening — Sentinel tick fires:**

```
SENTINEL TICK → processUser(ctx):
    └─ tickCount % 10 === 0 → collectPlanReminders(userId):
        └─ SELECT from conversation_plans WHERE status='pending' AND expires_at > NOW()
        └─ Row: scheduled_for="2026-04-02", now=Wednesday
        └─ daysUntil = 1.2 → (>= 0 && < 2) → shouldFire = true
        └─ Returns StimulusInput:
            {type:"plan_reminder", key:"plan_reminder_{id}", weight:0.75,
             data:{description:"Google placement interview", scheduled_for:"2026-04-02"}}

    └─ computeFusionScore(stimulus, userCtx):
        └─ score = weight(0.75) × pref_match × receptivity × (1 - fatigue)
        └─ score ≈ 0.68

    └─ applySocialOverlay() → no squad boost → score stays 0.68

    └─ decideSentinelActions():
        └─ fusionProactiveDecision():
            └─ mode = getFusionMode(pulseState) → threshold=0.65 (ENGAGED mode)
            └─ score(0.68) >= threshold(0.65) → FIRE
            └─ IST hour check: 7pm → within 8am-10pm window → FIRE

    └─ executeFire(stimulus, ctx):
        └─ upsertProactiveState() → proactive_state table (status='active')
        └─ splitIntoMessages(message, 'proactive') → burst-sender.ts
            └─ Message 1 (0.6s delay): "Hey Rohan!"
            └─ Message 2 (1.2s delay): "Your Google interview is tomorrow — hope you're feeling ready! Want me to help you prep anything?"
        └─ sendBurst() → Telegram Bot API
        └─ updateProactiveStatus() → proactive_state.status = 'delivered'
```

**Thursday evening — user hasn't replied to the reminder:**

```
SENTINEL TICK → collectPlanReminders():
    └─ scheduled_for="2026-04-02", now=Thursday evening
    └─ daysUntil = 0.1 → shouldFire = true again
    └─ BUT: proactive_state.status = 'delivered' → upsertProactiveState uses ON CONFLICT
    └─ Fusion scores it → FIRE
    └─ Message: "Hey! How did the Google interview go today? Hope you crushed it 🤞"
```

**After 7 days — Weekly Digest:**

```
SENTINEL TICK (weekly, every 10080 ticks) → runSessionPruner():
    └─ SELECT users with session_summaries older than 7 days
    └─ pruneOldSessions(userId):
        └─ compileWeeklyDigest(userId):
            └─ Idempotency check: SELECT weekly_digests WHERE week_start=$weekStart
            └─ SELECT session_summaries from past 7 days
            └─ generateResponse() → LLM compiles 150-200 word narrative:
                "This week Rohan was stressed about his Google placement interview
                 on Thursday. He asked about biryani spots in Indiranagar and
                 visited Meghana Foods. He prefers vegetarian food..."
            └─ INSERT weekly_digests (digest_text, plan_count)
            └─ addToGraph() → memory_graph updated with digest entities
        └─ DELETE sessions older than 7 days (summarized ones only)
        └─ DELETE session_summaries older than 7 days
```

**DB writes:** `session_summaries`, `memories`, `conversation_plans`, `proactive_state`, `weekly_digests`, `memory_graph`

---

## STORY 4 — STORYBOARD 2: THE SQUAD CONNECTOR

**Setup:** Rohan, Priya, Karan are in an Aria Squad.

```
DB state:
  squad_members: [{squad_id:"squad_abc", user_id:"rohan_id"},
                  {squad_id:"squad_abc", user_id:"priya_id"},
                  {squad_id:"squad_abc", user_id:"karan_id"}]
```

**Priya texts her Aria (12:30 PM):**

```
Priya: "I'm craving biryani da"
```

```
Priya's handler.ts runs:
    └─ fusionReactiveDecision():
        └─ buildSignalPacket():
            └─ signals.topic = null (isObviouslySimple → detected_topic=null)
            └─ extractTopicFromMessage("I'm craving biryani da")
                └─ words > 4 chars, not stop words: ["craving", "biryani"]
                └─ longest = "biryani"
            └─ currentDirection = "biryani"
        └─ insertSignalPacket():
            └─ signal_packets: {user_id:"priya_id", current_direction:"biryani",
                                 engagement_signal:"positive", created_at:NOW()}
```

**Karan texts his Aria (12:35 PM):**

```
Karan: "yaar biryani khana hai"
```

```
Karan's handler.ts runs:
    └─ extractTopicFromMessage("yaar biryani khana hai")
        └─ words > 4 chars: ["biryani", "khana"]
        └─ longest = "biryani"
    └─ insertSignalPacket():
        └─ signal_packets: {user_id:"karan_id", current_direction:"biryani"}
```

**Sentinel tick (12:45 PM) — Rohan's turn:**

```
SENTINEL TICK → processUser(rohan_ctx):
    └─ tickCount % 15 === 0 → collectSocialMonitor("rohan_id"):
        └─ SELECT squad_id FROM squad_members WHERE user_id='rohan_id'
            → squad_id = "squad_abc"
        └─ SELECT user_id FROM squad_members WHERE squad_id='squad_abc' AND user_id != 'rohan_id'
            → [priya_id, karan_id]
        └─ SELECT user_id, current_direction FROM signal_packets
           WHERE user_id IN [priya_id, karan_id]
           AND created_at > NOW() - INTERVAL '60 minutes'
           AND current_direction IS NOT NULL
            → [{user_id:"priya_id", current_direction:"biryani"},
               {user_id:"karan_id", current_direction:"biryani"}]
        └─ signalRows.length = 2 ≥ 2 → proceed
        └─ Word overlap check:
            directions[0] = ["biryani"]  (priya)
            directions[1] = ["biryani"]  (karan)
            common = ["biryani"] → overlappingTopic = "biryani"
        └─ Returns StimulusInput:
            {type:"social_convergence", key:"social_convergence_squad_abc_2026-03-29T12",
             weight:0.70, data:{squad_id:"squad_abc", topic:"biryani", active_count:2}}

    └─ applySocialOverlay():
        └─ social_convergence type → SOCIAL_CONVERGENCE_BOOST = 1.3×
        └─ compositeScore = 0.70 × 1.3 = 0.91

    └─ decideSentinelActions():
        └─ score(0.91) >= threshold(0.65) → FIRE
        └─ IST 12:45 PM → within active window → FIRE

    └─ executeFire():
        └─ splitIntoMessages() → burst:
            Message 1: "Hey Rohan!"
            Message 2: "Heads up — a couple of people in your squad are suddenly
                        talking about getting biryani right now 🍛
                        Want me to see what's open on Swiggy?"
        └─ sendBurst() → Telegram
        └─ proactive_state: {stimulus_type:"social_convergence", status:"delivered"}
```

**Rohan replies:**

```
User: "yes check swiggy"
```

```
handler.ts:
    └─ fusionReactiveDecision():
        └─ getActiveProactiveState() → finds social_convergence stimulus (status='active')
        └─ contextAdditions = ["[Proactive/social_convergence] ...biryani..."]
        └─ systemPrompt gets proactive context injected
    └─ brainHooks.routeMessage() → {useTool:true, toolName:"compare_food_prices",
                                     toolParams:{query:"biryani", location:"Bangalore"}}
    └─ executeAlphaTool("compare_food_prices", ...) → Swiggy MCP + Zomato scraper
    └─ callAlpha() → "Here's what's available on Swiggy right now..."
    └─ invalidateProactiveStimuli() → proactive_state.status = 'stale'
```

**DB writes:** `signal_packets`, `proactive_state`
**DB reads:** `squad_members`, `signal_packets`, `proactive_state`

---

## STORY 5 — STORYBOARD 3: THE DOER (Action Checklist)

**Trigger:** High-pulse user with travel intent.

```
User (pulse=82, PROACTIVE state): "I need to head to the airport tomorrow at 5 AM"
```

```
1. isObviouslySimple() → false → getDefaultClassification()
2. 6-way pipeline runs → pulseEngagementState = "PROACTIVE", pulseScore = 82
3. fusionReactiveDecision() → writes signal_packet {current_direction:"airport"}
4. brainHooks.routeMessage() → {useTool:true, toolName:"compare_rides",
                                  toolParams:{from:"Bangalore", to:"airport"}}

5. Step 7.7: detectActionMode():
   └─ pulseScore(82) >= 65 → gate passes
   └─ isQuestion=false → gate passes
   └─ toolHint="compare_rides" → TOOL_TO_CHECKLIST["compare_rides"] found
   └─ activeProactiveContext → weather stimulus → STIMULUS_TO_CHECKLIST["weather"] found
   └─ items = [
       {id:"compare_rides", label:"🚕 Compare Uber vs Rapido prices", toolName:"compare_rides"},
       {id:"compare_food",  label:"☕ Find coffee places open at 4 AM", toolName:"search_places"},
     ]
   └─ items.length >= 2 → shouldShowChecklist = true

6. tryStartActionChecklist(channelUserId, chatId, items):
   └─ getActiveFunnel() → no active funnel
   └─ INSERT proactive_funnels:
       {funnel_key:"action_checklist", status:"ACTIVE",
        context:{checklistItems:[...], selectedItems:[]}}
   └─ sendChecklistMessage():
       Telegram inline keyboard:
       [☐ 🚕 Compare Uber vs Rapido prices]
       [☐ ☕ Find coffee places open at 4 AM]
       (No "Go ✅" button yet — nothing selected)

7. handler returns {text: ""} — no LLM call this turn
```

**User taps "🚕 Compare Uber vs Rapido prices":**

```
Telegram callback: "checklist:action_checklist:compare_rides:toggle"

callback-handler.ts → handleChecklistCallback():
    └─ getActiveFunnel() → finds active funnel
    └─ action="toggle", itemId="compare_rides"
    └─ selectedIds = ["compare_rides"]
    └─ UPDATE proactive_funnels SET context={..., selectedItems:["compare_rides"]}
    └─ editChecklistMessage() → Telegram editMessageReplyMarkup:
        [✅ 🚕 Compare Uber vs Rapido prices]
        [☐ ☕ Find coffee places open at 4 AM]
        [Go ✅]   ← appears now
```

**User taps "☕ Find coffee places open at 4 AM":**

```
Telegram callback: "checklist:action_checklist:compare_food:toggle"

    └─ selectedIds = ["compare_rides", "compare_food"]
    └─ editChecklistMessage():
        [✅ 🚕 Compare Uber vs Rapido prices]
        [✅ ☕ Find coffee places open at 4 AM]
        [Go ✅]
```

**User taps "Go ✅":**

```
Telegram callback: "checklist:action_checklist:execute"

handleChecklistCallback():
    └─ action="execute"
    └─ pendingActions = [
        {toolName:"compare_rides", toolParams:{}},
        {toolName:"search_places", toolParams:{query:"coffee open 4am"}}
      ]
    └─ UPDATE proactive_funnels SET status='COMPLETED'
    └─ Returns {text:"On it! Running 2 tasks...", pendingActions:[...]}

callback-handler.ts → executeActionChecklist(userId, chatId, pendingActions, ctx):
    └─ sendMessage("On it! Running 2 tasks for you...")
    └─ enrichParams() → adds location from preferences
    └─ Promise.allSettled([
        executeAlphaTool("compare_rides", {from:"Bangalore", to:"airport"}, userId),
        executeAlphaTool("search_places", {query:"coffee open 4am", location:"Bangalore"}, userId)
      ])
    └─ Both run in parallel via tool-executor.ts → tool-sandbox.ts → tools/

    Result 1 (0.6s typing delay):
        sendMessage("🚕 Uber: ₹380 | Rapido: ₹290 | Ola: ₹340
                     Rapido is cheapest at 5 AM. Book here: [link]")

    Result 2 (1.2s typing delay):
        sendMessage("☕ Starbucks Koramangala — open 24h
                     Third Wave Coffee — opens 6 AM
                     Café Coffee Day Airport — open from 4 AM")

    └─ pulseService.recordEngagement() → tool_commitment signal → +22 pulse
```

**DB writes:** `proactive_funnels`, `pulse_engagement_scores`, `pulse_history`
**External APIs:** Rapido/Uber/Ola (ride compare), Google Places (coffee)

---

## STORY 6 — STORYBOARD 4: THE HUMAN TEXTER (Burst Messaging)

**Trigger:** Sentinel detects rain + user usually orders in when it rains.

```
SENTINEL TICK (8:15 AM):
    └─ collectStimulusRefresh(userId):
        └─ getPersonalizedStimuli(userId) → stimulus-router.ts
            └─ getWeatherState("Bangalore") → OpenWeather API
                └─ condition="heavy_rain", isRaining=true
            └─ Returns StimulusAction:
                {type:"weather", message:"Heavy rain expected in Bangalore in ~1 hour",
                 suggestedAction:"Order in before surge pricing hits",
                 hashtag:"rain_order", priority:"high"}
        └─ StimulusInput: {type:"weather", weight:0.9, data:{message:..., suggestedAction:...}}

    └─ computeFusionScore():
        └─ preferences: {rain_behavior:"order_in"} → pref_match = 1.0
        └─ pulseState = "ENGAGED" → receptivity = 0.85
        └─ score = 0.9 × 1.0 × 0.85 × (1 - fatigue) ≈ 0.76

    └─ decideSentinelActions() → FIRE (score 0.76 > threshold 0.65)

    └─ executeFire():
        └─ upsertProactiveState() → proactive_state table
        └─ splitIntoMessages(message, 'proactive'):
            └─ burst-sender.ts splits into:
                Part 1: "Hey! Looks like it's going to pour rain in Bangalore in about an hour."
                        typingDelay = ceil(47 chars / 15) × 200ms = 600ms
                Part 2: "Since you usually order in when it rains, want me to pull up the
                         Blinkit grocery checklist or check Zomato for you before the
                         surge pricing hits?"
                        typingDelay = ceil(130 chars / 15) × 200ms = 1800ms
        └─ sendBurst(chatId, burstMessages):
            ├─ sendChatAction("typing") → Telegram
            ├─ sleep(600ms)
            ├─ sendMessage(Part 1) → Telegram
            ├─ sendChatAction("typing") → Telegram
            ├─ sleep(1800ms)
            └─ sendMessage(Part 2) → Telegram
        └─ updateProactiveStatus() → 'delivered'
```

**User replies:**

```
User: "check zomato"
```

```
handler.ts:
    └─ fusionReactiveDecision():
        └─ getActiveProactiveState() → weather stimulus (status='active')
        └─ contextAdditions = ["[Proactive/weather] rain_order_high: {message:..., suggestedAction:...}"]
        └─ systemPrompt += proactive context block
    └─ callAlpha() receives proactiveState = [weather stimulus row]
        └─ context-manager.ts builds proactive block (300 token budget):
            "Active proactive context:
             [weather/rain_order_high] score=0.76: {message:'Heavy rain...', suggestedAction:'Order in...'}"
    └─ brainHooks.routeMessage() → {useTool:true, toolName:"compare_food_prices"}
    └─ executeAlphaTool("compare_food_prices", {platform:"zomato", location:"Bangalore"})
    └─ callAlpha() → response with Zomato deals
    └─ invalidateProactiveStimuli() → proactive_state.status = 'stale'
```

**DB writes:** `proactive_state`
**External APIs:** OpenWeather, Zomato scraper

---

## STORY 7 — PUSHBACK PROTOCOL

**Trigger:** User rejects a proactive message.

```
Aria (proactive): "Hey! Traffic is heavy on Outer Ring Road right now.
                   Want me to compare cab prices?"

User: "no not now"
```

```
handler.ts:
    └─ isCancellationMessage("no not now") → true → isRejection = true
    └─ pendingToolStore.delete(userId)
    └─ recentToolContextStore.delete(userId)
    └─ fusionReactiveDecision():
        └─ extractedSignals.sentiment = "negative"
        └─ buildSignalPacket() → engagement_signal = "negative"
        └─ insertSignalPacket() → signal_packets

    └─ pulseService.recordEngagement():
        └─ extractEngagementSignals() → rejection = -30
        └─ scoreDelta = -30
        └─ pulse: 72 → 42 (drops below ENGAGED threshold of 50)
        └─ transitionState() → ENGAGED → CURIOUS
        └─ INSERT pulse_history

NEXT SENTINEL TICK:
    └─ evaluateModeSwitch(ctx):
        └─ pushbackCount = 1 → evaluatePushback(1) → RETRY_PIVOT
        └─ mode stays PROACTIVE but threshold raised by +0.1

    └─ Next traffic stimulus scores 0.71:
        └─ retryThreshold = 0.65 + 0.1 = 0.75
        └─ score(0.71) < retryThreshold(0.75) → BUFFER (not FIRE)
        └─ executeBuffer() → proactive_state written, no Telegram message

USER SENDS NEXT MESSAGE:
    └─ fusionReactiveDecision():
        └─ getActiveProactiveState() → buffered traffic stimulus
        └─ contextAdditions injected into prompt
        └─ Alpha sees context: "traffic is heavy" → weaves it naturally into response
        └─ No forced proactive push

IF USER REJECTS AGAIN:
    └─ pushbackCount = 2 → evaluatePushback(2) → BACK_OFF
    └─ evaluateModeSwitch() → mode switches to REACTIVE
    └─ saveSentinelMode() → sentinel_mode table
    └─ All future stimuli → BUFFER only (no FIRE)
    └─ Recovery: 3 consecutive positive interactions → checkRecovery() → mode back to PROACTIVE
```

**DB writes:** `signal_packets`, `pulse_engagement_scores`, `pulse_history`, `proactive_state`, `sentinel_mode`

---

## STORY 8 — CROSS-CHANNEL IDENTITY (/link command)

```
User on Telegram: "/link"
```

```
handler.ts:
    └─ linkMatch = rawMessage.match(/^\/link(?:\s+(\d{6}))?$/i)
    └─ handleLinkCommand(channel="telegram", channelUserId, code=null):
        └─ generateLinkCode(userId) → 6-digit code, stored in identity_links table
        └─ Returns: "Your link code is: 483921 (expires in 10 min)"
```

```
User on Slack: "/link 483921"
```

```
    └─ handleLinkCommand(channel="slack", channelUserId, code="483921"):
        └─ redeemLinkCode("483921"):
            └─ SELECT from identity_links WHERE code='483921' AND expires_at > NOW()
            └─ Found: links telegram_user_id to slack_user_id via person_id
            └─ UPDATE users SET person_id = shared_person_id for both
        └─ Returns: "Linked! Your Telegram and Slack accounts are now connected."

EFFECT on memory search:
    └─ getLinkedUserIds(userId) → [telegram_user_id, slack_user_id]
    └─ scoredMemorySearch([telegram_id, slack_id], query, 5)
        └─ Searches memories from BOTH channels
        └─ Cross-channel context: "User mentioned Hampi trip on Slack last week"
```

---

## STORY 9 — SOCIAL GRAPH (/friend and /squad commands)

```
User: "/friend add @priya"
```

```
    └─ handleFriendCommand(userId, "telegram", "add @priya"):
        └─ resolveUserByPlatformId("priya") → priya's userId
        └─ addFriend(userId, priyaId):
            └─ INSERT user_relationships (user_id, friend_id, status='pending')
        └─ Returns: "Friend request sent to Priya!"

Priya: "/friend accept @rohan"
    └─ acceptFriend(priyaId, rohanId):
        └─ UPDATE user_relationships SET status='accepted'
        └─ INSERT user_relationships (priya→rohan, status='accepted')
```

```
User: "/squad create"
```

```
    └─ handleSquadCommand(userId, "telegram", "create"):
        └─ createSquad(userId):
            └─ INSERT squads (name="Rohan's Squad", created_by=userId)
            └─ INSERT squad_members (squad_id, user_id=userId, role='admin')
        └─ Returns: "Squad created! Share this invite: /squad join abc123"

User: "/squad invite @priya"
    └─ inviteToSquad(userId, squadId, priyaId):
        └─ INSERT squad_invites (squad_id, invited_by=userId, invitee_id=priyaId)

Priya: "/squad join abc123"
    └─ acceptSquadInvite(priyaId, "abc123"):
        └─ INSERT squad_members (squad_id, user_id=priyaId, role='member')
```

**Effect:** Squad members now participate in social convergence detection (Story 4).

---

## STORY 10 — PULSE ENGINE (Engagement Scoring)

**How Aria decides how "engaged" a user is:**

```
Every message → pulseService.recordEngagement():
    └─ extractEngagementSignals(input):
        Signal detection:
        ├─ urgency (+14):    "asap", "urgent", "right now", "stuck"
        ├─ desire (+10):     "I want", "I need", "book", "find me", "show me"
        ├─ rejection (-30):  "no", "stop", "not now", "skip", "not interested"
        ├─ fastReply (+8):   reply within 90 seconds of previous message
        ├─ topicPersistence (+7): same topic words as previous message
        ├─ positive (+20):   "thanks", "great", "awesome", "yes", "sounds good"
        ├─ toolCommitment (+22): "book it", "go ahead", "order", "confirm"
        ├─ slowReply (-5):   reply after > 10 minutes
        └─ ignoredProactive (-12): no reply to a FIRE within cooldown window

    └─ transitionState(currentScore + delta):
        PASSIVE  (0-24):  Aria is mostly reactive, minimal proactive
        CURIOUS  (25-49): Aria starts suggesting, light proactive
        ENGAGED  (50-79): Aria proactively fires, shows checklists
        PROACTIVE (80-100): Aria fires frequently, action mode enabled

    └─ Hysteresis buffer = 5 points (prevents rapid state flipping)
    └─ Decay: score halves every 24 hours of inactivity
```

**Sentinel uses pulse state to gate proactive firing:**

```
PASSIVE:  threshold=0.90 (almost never fires)
CURIOUS:  threshold=0.80
ENGAGED:  threshold=0.65 (fires on good stimuli)
PROACTIVE: threshold=0.55 (fires readily)
```

---

## STORY 11 — MEMORY ARCHITECTURE (3-Tier)

```
HOT TIER (in-memory, per session):
    └─ session.messages[] — last 20 messages in PostgreSQL sessions table
    └─ pulseService hot cache — in-memory Map<userId, PulseState>
    └─ recentToolContextStore — in-memory Map<userId, ToolContext> (45 min TTL)

RECENT TIER (PostgreSQL, searchable):
    └─ memories table — vector embeddings of key facts
        └─ Written by: enqueueMemoryWrite() → processMemoryWriteQueue()
        └─ Read by: scoredMemorySearch() (cosine 0.6 + recency 0.2 + importance 0.2)
    └─ memory_graph table — entity relationships
        └─ "Rohan → likes → biryani", "Rohan → visited → Meghana Foods"
        └─ Written by: addToGraph() via archivist queue
        └─ Read by: searchGraph() → 2-hop traversal
    └─ session_summaries — episodic memory (2-4 sentence summaries)
        └─ Written by: checkAndSummarizeSessions() every 5 min
        └─ Embedded with pgvector for semantic search

DIGEST TIER (PostgreSQL, compressed):
    └─ weekly_digests — 150-200 word weekly narrative
        └─ Written by: compileWeeklyDigest() weekly via Sentinel
        └─ Read by: context-manager.ts (injected into Alpha's system prompt)
    └─ conversation_plans — extracted future plans with dates
        └─ Written by: extractPlansFromSummary() after each session
        └─ Read by: collectPlanReminders() every 10 min via Sentinel
```

**Context injection into Alpha (token budget 8192):**

```
context-manager.ts buildContext():
    ├─ soul-v2.md:          ~500 tokens  (Aria's personality)
    ├─ user context:        ~1000 tokens (name, location, preferences, memories, graph)
    ├─ proactive state:     ~300 tokens  (active Sentinel stimuli)
    ├─ pulse context:       ~200 tokens  (engagement state + top topics)
    ├─ session history:     ~1500 tokens (last 6-8 messages)
    └─ tool results:        ~800 tokens  (compressed tool output)
    Total: ~4300 tokens → 3892 tokens headroom for response
```

---

## STORY 12 — TOPIC INTENT LIFECYCLE

```
User: "I want to visit Hampi next month"
```

```
topicIntentService.processMessage():
    └─ Detects "Hampi" + "visit" + "next month" → topic="Hampi trip"
    └─ INSERT topic_intents:
        {topic:"Hampi trip", category:"travel", confidence:75,
         phase:"active", strategy:"time_sensitive",
         last_signal_at:NOW()}

User (next day): "what's the best time to visit Hampi?"
    └─ topicIntentService.processMessage():
        └─ Topic overlap detected → confidence += 15 → 90
        └─ phase stays "active"

SENTINEL TICK (3 days later):
    └─ collectTopicFollowup(userId):
        └─ SELECT from topic_intents WHERE phase IN ('active','pending')
           AND created_at > NOW() - INTERVAL '7 days'
        └─ Row: strategy="time_sensitive", hoursSinceSignal=72 > 24 → shouldFire=true
        └─ Returns StimulusInput {type:"topic_followup", weight:0.60}
    └─ Sentinel scores → FIRE
    └─ Message: "Hey! You mentioned wanting to visit Hampi. Want me to check
                 flights and hotels for next month?"

User: "yes check flights"
    └─ Execution Bridge: executingTopic found (phase="executing")
    └─ isConfirmatoryMessage("yes check flights") → true
    └─ resolveToolFromTopic(hampiTopic) → {toolName:"search_flights", toolParams:{to:"Hampi"}}
    └─ executeAlphaTool("search_flights", ...) → Amadeus API
    └─ topicIntentService.completeTopic() → phase="completed"
    └─ logTopicCompleted()
```

---

## COMPLETE DATA FLOW DIAGRAM

```
USER MESSAGE
    │
    ▼
[Telegram Webhook]
    │
    ├─ /link, /friend, /squad → early return
    │
    ▼
[Sanitize] → [Rate Limit] → [Get/Create User+Session]
    │
    ├─ Funnel reply? → [proactive_funnels] → early return
    ├─ Task reply?   → [task_orchestrator] → early return
    │
    ▼
[Classify: simple/moderate]
    │
    ├─ simple: skip memory/graph
    └─ moderate: 6-way Promise.all
                 ├─ [memories] (pgvector)
                 ├─ [memory_graph]
                 ├─ [user_preferences]
                 ├─ [agenda_goals]
                 ├─ [topic_intents]
                 └─ [pulse_engagement_scores]
    │
    ▼
[Fusion Reactive Decision]
    ├─ READ: [proactive_state]
    ├─ WRITE: [signal_packets] (current_direction extracted from message)
    └─ OUTPUT: contextAdditions[], proactiveContext[]
    │
    ▼
[Route Decision (brainHooks gates)]
    ├─ Location gate → ask for location → early return
    ├─ Confirmation gate → ask to confirm → early return
    ├─ Execution bridge → topic executing phase
    └─ Action checklist gate → [proactive_funnels] → early return
    │
    ▼
[executeAlphaTool() if useTool]
    └─ [tool-sandbox] → [tools/] → External APIs
    │
    ▼
[composeSystemPrompt()]
    └─ soul-v2.md + user ctx + memories + proactive ctx + tool results
    │
    ▼
[callAlpha() — Together AI → Fireworks → Groq]
    └─ chatWithTools() Call 1 → tool decision or direct response
    └─ (if tool) executeAlphaTool() → Call 2 with result
    │
    ▼
[Filter] → [Store session] → [Track usage]
    │
    ▼
[setImmediate fire-and-forget]
    ├─ [topic_intents] update
    ├─ [pulse_engagement_scores] update
    └─ [agenda_goals] update
    │
    ▼
[enqueueMemoryWrite → memory_write_queue]
    ├─ ADD_MEMORY → [memories]
    ├─ GRAPH_WRITE → [memory_graph]
    ├─ SAVE_PREFERENCE → [user_preferences]
    └─ UPDATE_GOAL → [agenda_goals]
    │
    ▼
[Burst sender → Telegram]
    └─ splitIntoMessages() → typing delays → multiple messages

═══════════════════════════════════════════════════════

BACKGROUND (every 60s — Sentinel Loop)
    │
    ├─ Every tick:    [memory_write_queue] drain
    ├─ Every 5 min:   [sessions] summarize → [session_summaries]
    │                 → [conversation_plans] extract
    ├─ Every 10 min:  [conversation_plans] → plan reminders
    │                 [topic_intents] → topic followups
    ├─ Every 15 min:  [squad_members] + [signal_packets] → social convergence
    ├─ Every 30 min:  External APIs → [stimulus_cache] refresh
    │                 [topic_intents] → topic followups
    ├─ Every 60 min:  [local_event_stimulus] check
    │                 [proactive_state] cleanup
    └─ Every 7 days:  [session_summaries] → [weekly_digests]
                      [sessions] prune old

    Per user per tick:
    └─ Collect stimuli → computeFusionScore() → applySocialOverlay()
       → decideSentinelActions() → FIRE/BUFFER/DROP
       → FIRE: [proactive_state] write + Telegram burst send
       → BUFFER: [proactive_state] write (Alpha reads on next message)
```
