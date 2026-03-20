# NemoClaw Architecture Summary (NVIDIA)

**Repo:** github.com/NVIDIA/NemoClaw
**Analysis Date:** 2026-03-17

---

## What It Solves

NemoClaw sandboxes OpenClaw (an autonomous AI agent framework) inside NVIDIA OpenShell, controlling network egress, filesystem access, and inference routing through declarative policy. It enables **safe always-on autonomous agent operation** in a controlled environment.

**Key insight for Personifi:** NemoClaw is an **infrastructure-level sandbox** — not an agent framework itself. It wraps an existing agent (OpenClaw) with security, policy enforcement, and inference provider management. Its patterns are relevant for **deployment architecture** but not for agent behavior, proactive logic, or multi-source reasoning.

---

## Core Architecture: Two-Tier Plugin + Blueprint

### Plugin Layer (TypeScript/Node.js)
**Entry:** `nemoclaw/src/index.ts` (lines 179-259)

Registers three extension types into the OpenClaw host:
1. **Slash Command** (`api.registerCommand()`) — `/nemoclaw` for chat-based control
2. **CLI Subcommands** (`api.registerCli()`) — `openclaw nemoclaw <command>` with 8 subcommands: status, launch, migrate, connect, logs, onboard, eject, slash
3. **Model Provider** (`api.registerProvider()`) — NVIDIA NIM provider with 4 Nemotron models

### Blueprint Layer (Python)
**Entry:** `nemoclaw-blueprint/orchestrator/runner.py` (lines 1-346)

Subprocess-driven orchestration:
- Spawned by `execBlueprint()` in `nemoclaw/src/blueprint/exec.ts`
- Protocol: stdout lines like `PROGRESS:pct:label` and `RUN_ID:id`
- Actions: `plan` → `apply` → `status` → `rollback`
- Manifest: `blueprint.yaml` — version constraints, sandbox config, inference profiles

**Orchestration Flow:**
1. Plugin resolves blueprint version from registry (or cache)
2. Plugin verifies SHA-256 digest and compatibility
3. Plugin spawns blueprint runner as subprocess
4. Blueprint parses `blueprint.yaml`, calls `openshell` CLI commands
5. Blueprint writes plan/state to `~/.nemoclaw/state/runs/<run_id>/`
6. Plugin parses stdout, extracts RUN_ID, reports progress

---

## Persistent State Model

Three layers of state, all file-based:

| Layer | File | Contents |
|-------|------|----------|
| **Plugin State** | `~/.nemoclaw/state/nemoclaw.json` | lastRunId, lastAction, blueprintVersion, sandboxName, migrationSnapshot |
| **Onboard Config** | `~/.nemoclaw/config.json` | endpointType, endpointUrl, model, profile, credentialEnv |
| **Migration Snapshot** | `~/.nemoclaw/state/snapshots/<timestamp>/` | Tar archives of host state, symlink manifest, external root bindings |
| **Run Artifacts** | `~/.nemoclaw/state/runs/<run_id>/plan.json` | run_id, profile, sandbox_name, inference config, timestamp |

**Cross-time persistence:** Every status check loads `nemoclaw.json`. Eject reads persisted state to locate migration snapshot. Logs command uses saved `lastRunId`.

**Ref:** `nemoclaw/src/blueprint/state.ts` (lines 1-70), `nemoclaw/src/onboard/config.ts` (lines 1-54), `nemoclaw/src/commands/migration-state.ts` (lines 58-76)

---

## Trigger Mechanisms

**No event bus, no pub/sub, no webhooks.** Triggering is entirely synchronous:

1. **Chat slash commands** — `/nemoclaw status|eject|onboard` — registered in `nemoclaw/src/commands/slash.ts`
2. **CLI commands** — `openclaw nemoclaw <cmd>` — wired via commander.js in `nemoclaw/src/cli.ts`
3. **Blueprint subprocess completion** — `proc.on("close")` event in `nemoclaw/src/blueprint/exec.ts`
4. **Network policy interception** — OpenShell blocks unknown hosts, surfaces in TUI for operator approval (defined in `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`)

---

## Tool Use Pattern

NemoClaw does NOT register code execution tools. It registers a **model provider**:

```typescript
api.registerProvider({
    id: "nvidia-nim",
    label: "NVIDIA NIM (build.nvidia.com)",
    aliases: ["nvidia", "nim"],
    models: { chat: [/* 4 Nemotron models */] },
    auth: [{ type: "bearer", envVar: credentialEnv }]
});
```

Tools (bash, file access, etc.) are managed by OpenClaw natively inside the sandbox. NemoClaw only controls **which inference endpoints** are available and **which network egress** is permitted.

**Ref:** `nemoclaw/src/index.ts` (lines 203-245)

---

## Agent Lifecycle

| Phase | What Happens | Where |
|-------|-------------|-------|
| **Init** | Interactive onboarding (endpoint, API key, model) | `nemoclaw/src/commands/onboard.ts` |
| **Blueprint Resolve** | Download/cache blueprint, verify digest | `nemoclaw/src/blueprint/resolve.ts`, `verify.ts` |
| **Sandbox Create** | `openshell sandbox create`, provider create, inference set | `runner.py` lines 138-246 |
| **Decide-to-Act** | Agent decision loop runs inside sandbox (OpenClaw native) | Not NemoClaw code |
| **Execute** | Agent calls model via registered provider; OpenShell routes | Transparent gateway |
| **Sleep/Persist** | Plugin saves state after operations | `nemoclaw/src/commands/launch.ts` lines 110-116 |
| **Eject** | Rollback: stop sandbox, restore from snapshot | `nemoclaw/src/commands/eject.ts` |

---

## Fusion / Signal Ranking / Multi-Source Reasoning

**None.** NemoClaw has zero concepts of:
- Multi-source fact fusion
- Signal/evidence confidence scoring
- Decision ranking between competing conclusions
- Bayesian aggregation

The closest pattern is parallel status gathering (`Promise.all([getSandboxStatus(), getInferenceStatus()])` in `status.ts` line 22-25), which is simple data aggregation with no reasoning.

---

## Data Caching / Freshness

**Minimal:**
- **Blueprint version cache** — `~/.nemoclaw/blueprints/<version>/`, no TTL, cached indefinitely until manual clear. "Latest" always fetches from registry. (`nemoclaw/src/blueprint/resolve.ts` lines 62-80)
- **Status queries** — Zero caching, real-time check every time via OpenShell CLI with 5s timeout
- **No external data fetching layer** — No agent data cache, no API response cache, no freshness tracking

---

## Relevance to Personifi Vision

| NemoClaw Pattern | Useful for Personifi? | How |
|-----------------|----------------------|-----|
| Declarative network policy | Maybe | Could enforce which APIs Aria's scrapers can call |
| Blueprint versioning + digest | No | Over-engineered for Personifi's needs |
| Plugin registration SDK | Partially | Pattern for registering tool providers; Aria already has BodyHooks |
| Migration snapshot + rollback | No | Deployment concern, not agent behavior |
| Subprocess orchestration | Partially | Pattern for spawning background workers (Playwright scrapers) |
| Strict-by-default security | Yes | Relevant for bot account management (e-SIM, real accounts) |

**Bottom line:** NemoClaw is a deployment/security wrapper, not an agent intelligence framework. Its patterns are relevant for infrastructure but contribute almost nothing to the Output-First Agent vision's core needs (proactive triggers, fusion ranking, social graph intelligence, data freshness).
