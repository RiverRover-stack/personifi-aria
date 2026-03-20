# Nanobot Architecture Summary (HKUDS)

**Repo:** github.com/HKUDS/nanobot
**Analysis Date:** 2026-03-17

---

## What It Solves

Nanobot is an ultra-lightweight personal AI assistant (~99% less code than OpenClaw) focused on simplicity, single-agent operation, and workspace-centric state. It provides a clean, modular agent loop with memory consolidation, tool registration, background subagents, and multi-channel support.

**Key insight for Personifi:** Nanobot has the **most portable patterns** of the three codebases — its tool registry, memory consolidation, cron service, and message bus are all directly adaptable. However, it lacks proactive intelligence, social graph, and multi-user coordination.

---

## Agent Loop: How It "Ticks"

**File:** `nanobot/agent/loop.py` (lines 37-506)

```
AgentLoop.run()
  ├─ Consumes inbound messages from MessageBus (1.0s timeout)
  ├─ Routes commands: /stop, /restart, /help, /new
  └─ Dispatches normal messages → _process_message()
     ├─ Loads/creates Session from SessionManager
     ├─ Consolidates old messages if token budget exceeded
     ├─ Builds initial message list via ContextBuilder
     └─ Runs _run_agent_loop()
        └─ Iteration Loop (max 40 iterations)
           ├─ Call LLM with messages + tool definitions
           ├─ If tool_calls: execute each → append results → loop
           └─ If no tool_calls: append final response → break
```

**Key design decisions:**
- **Sequential tool execution** — no parallel tool calls per iteration
- **Append-only session history** — messages never deleted, only consolidated
- **Global processing lock** — one message processed at a time per agent instance
- **Max 40 iterations** before forced stop (prevents infinite loops)

**Ref:** `loop.py` lines 183-254

---

## Proactive vs Reactive Behavior

### Reactive (Primary)
Agent waits for messages on the bus. Processes on demand via channels (Telegram, Discord, Slack, CLI).

### Proactive Patterns (Three Mechanisms)

**1. Heartbeat Service** (`heartbeat/service.py` lines 40-100)
- Periodic wake-up (configurable interval, e.g., 30 min)
- Two-phase decision: LLM reads `HEARTBEAT.md` → decides if action needed → executes via callback
- Triggered by external scheduler

**2. Cron Service** (`cron/service.py` lines 63-150)
- Three trigger types: `at` (one-time ISO datetime), `every` (interval ms), `cron` (expression + timezone)
- State persistence: next_run_at_ms, last_run_at_ms, last_error
- Jobs can be `delete_after_run` for one-shot execution

**3. Subagent Background Tasks** (`agent/subagent.py` lines 50-81)
- Spawned via `SpawnTool` (`tools/spawn.py`)
- Runs as `asyncio.create_task` (truly parallel)
- Own tool registry (no spawn recursion, no message tool)
- Announces result back via system message injection

**Relevance to Personifi:** The Heartbeat pattern (external trigger → LLM decision → conditional action) is the closest thing to Personifi's "always-on agent" vision. The Cron service is directly portable.

---

## Memory System: Three Layers

**File:** `agent/memory.py` (lines 75-358), `session/manager.py` (lines 16-243)

| Layer | Storage | Scope | Update Pattern |
|-------|---------|-------|----------------|
| **Session History** | JSONL files in `workspace/sessions/` | Per channel:chat_id | Append-only, saved after each turn |
| **Long-term Memory** | `workspace/memory/MEMORY.md` | Global | LLM-driven update during consolidation |
| **History Log** | `workspace/memory/HISTORY.md` | Global | Timestamped entries, grep-searchable |

### Consolidation Flow (Token-Aware)
```
maybe_consolidate_by_tokens()
  ├─ Estimate current prompt tokens
  ├─ If > context_window // 2:
  │  └─ Loop: pick_consolidation_boundary() → archive_messages()
  │     ├─ Format messages to plain text
  │     ├─ LLM call with save_memory tool (forced choice)
  │     ├─ Extract history_entry + memory_update
  │     ├─ Append to HISTORY.md, update MEMORY.md
  │     └─ Fallback: raw dump after 3 LLM failures
```

**Key patterns:**
- Boundary picked at user-turn edges (never breaks tool-call chains)
- Session-level locks prevent concurrent consolidation
- Graceful degradation: if LLM fails 3x, raw-archive messages

**Relevance to Personifi:** Personifi has a more sophisticated memory system (pgvector + graph), but nanobot's consolidation pattern (automatic context window management) could supplement Aria's session handling.

---

## Tool Integration Pattern

**Files:** `tools/base.py` (lines 7-182), `tools/registry.py` (lines 8-71)

### Registration
```python
AgentLoop.__init__()
  └─ _register_default_tools()
     ├─ ReadFileTool, WriteFileTool, EditFileTool, ListDirTool
     ├─ ExecTool (shell execution)
     ├─ WebSearchTool, WebFetchTool
     ├─ MessageTool (cross-channel messaging)
     ├─ SpawnTool (subagent spawning)
     └─ CronTool (optional scheduling)
```

### Tool Base Class
```python
class Tool(ABC):
    name: str
    description: str
    parameters: dict  # JSON schema

    to_schema()        # → OpenAI function schema format
    cast_params()      # → safe type casting from LLM output
    validate_params()  # → JSON schema validation
    execute(**kwargs)   # → async, returns str
```

### Execution Pipeline
```python
ToolRegistry.execute(name, params)
  ├─ Lookup tool by name
  ├─ Cast parameters (string→int, string→float, string→bool)
  ├─ Validate via JSON schema
  ├─ Execute tool.execute(**params)
  └─ On error: return error + "[Analyze the error above and try a different approach.]"
```

### MCP Integration
```python
connect_mcp_servers()
  ├─ Auto-detect transport (stdio, SSE, HTTP streaming)
  ├─ Initialize ClientSession
  ├─ List tools from server
  ├─ Wrap each tool in MCPToolWrapper (prefixed: mcp_{server}_{tool})
  └─ Register to ToolRegistry
```

**Relevance to Personifi:** The abstract Tool base class with JSON schema validation and automatic type casting is cleaner than Personifi's current BodyHooks pattern. The MCP wrapper pattern is similar to Personifi's `mcp-client.ts`.

---

## User Model / Profile

**Files:** `templates/USER.md`, `templates/SOUL.md`, `context.py` (lines 27-54)

Nanobot uses **workspace-level identity files** loaded into the system prompt:

1. **SOUL.md** — Agent personality and values
2. **USER.md** — User preferences, communication style, goals
3. **AGENTS.md** — Optional agent capabilities context
4. **TOOLS.md** — Optional tool context

System prompt assembly (`context.py`):
```
Identity section → Bootstrap files (SOUL, USER, AGENTS, TOOLS) →
Long-term memory (MEMORY.md) → Always-loaded skills → Skills summary
```

**No built-in user identification** beyond channel/chat_id. User profile is per-workspace, not per-user-ID.

**Relevance to Personifi:** Personifi already has a much richer user model (PostgreSQL users table, preferences, affinity scores, identity linking). Nanobot's pattern is simpler but the SOUL.md approach mirrors Personifi's `config/SOUL.md`.

---

## Most Portable Components (Ranked)

| Component | File(s) | Portability | Notes |
|-----------|---------|-------------|-------|
| **Tool Base + Registry** | `tools/base.py`, `tools/registry.py` | ★★★★★ | Abstract class, JSON schema validation, parameter casting — all generic |
| **Message Bus** | `bus/queue.py` | ★★★★★ | Pure asyncio.Queue, completely decoupled |
| **Session Manager** | `session/manager.py` | ★★★★☆ | JSONL-based; easy to swap to PostgreSQL backend |
| **Cron Service** | `cron/service.py` | ★★★★☆ | General-purpose scheduling (at, every, cron expressions) |
| **Memory Consolidator** | `agent/memory.py` | ★★★★☆ | Token-aware sliding window; provider-agnostic logic |
| **LLM Provider Base** | `providers/base.py` | ★★★★☆ | Abstract interface with retry logic and transient error detection |
| **MCP Wrapper** | `tools/mcp.py` | ★★★★☆ | Transport-agnostic (stdio, SSE, HTTP) |
| **Context Builder** | `agent/context.py` | ★★★★☆ | Message assembly + bootstrap file loading |
| **Subagent Manager** | `agent/subagent.py` | ★★★☆☆ | Background task pattern; tied to main agent bus |
| **Skills System** | `agent/skills.py` | ★★★☆☆ | Markdown skills with YAML frontmatter; progressive loading |

---

## Data Access Abstraction

**Minimal.** Nanobot has:

1. **Session caching** — In-memory dict cache with lazy load from disk (`session/manager.py` lines 125-190)
2. **Lazy MCP connection** — Connect once on first message, retry on next if failed
3. **Provider retry** — Exponential backoff (1s, 2s, 4s) on transient errors (rate limits, 5xx, timeouts)
4. **Memory consolidation fallback** — If LLM fails 3x, raw-dump messages
5. **URL safety validation** — SSRF protection for web fetch/search tools

**No data caching layer, no TTL management, no freshness tracking, no background data polling.**

---

## Key Differences from Personifi

| Aspect | Nanobot | Personifi/Aria |
|--------|---------|----------------|
| **Agent type** | Single-user personal assistant | Multi-user social agent |
| **Proactive behavior** | Heartbeat + Cron (basic) | 12+ cron jobs, stimulus system, affinity scoring |
| **Memory** | File-based (MEMORY.md, HISTORY.md) | pgvector + entity graph + Redis cache |
| **User model** | Workspace-level markdown file | PostgreSQL users + preferences + identity linking |
| **Social graph** | None | Entity-relationship with recursive CTE traversal |
| **Data access** | Web search/fetch tools only | 8+ scrapers, MCP integrations, rate cards |
| **Multi-model** | Single provider | Dual-LLM (8B classifier + 70B personality) |
| **Channels** | Telegram, Discord, Slack, CLI | Telegram, WhatsApp, Slack |
