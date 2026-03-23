/**
 * Alpha Tool Executor (#129)
 *
 * Maps Alpha tool names → existing tool implementations in src/tools/index.ts.
 * This is the only file that knows the name mapping between Alpha's curated
 * schema names and the legacy tool registry names.
 *
 * All calls flow through executeThroughSandbox() in ./tool-sandbox.ts, which
 * enforces rate limiting, timeouts, retries, output compression, and audit
 * logging.  This file does NOT validate — it only maps names and dispatches.
 */

import { logger as rootLogger } from './logger.js'
import { ALPHA_TOOL_NAMES } from './tool-definitions.js'
import { executeThroughSandbox } from './tool-sandbox.js'
import { parseToolArgs } from './tool-arg-schemas.js'
import type { ToolExecutionResult } from './hooks.js'
import type { SandboxConfig } from './tool-sandbox.js'

const log = rootLogger.child({ module: 'tool-executor' })

// ─── Name Mapping ─────────────────────────────────────────────────────────────

/**
 * Maps Alpha tool names to existing tool registry names.
 * event_lookup uses search_places with an event type hint injected below.
 */
const ALPHA_TO_LEGACY: Record<string, string> = {
    cab_compare: 'compare_rides',
    place_search: 'search_places',
    weather_check: 'get_weather',
    food_finder: 'compare_food_prices',
    price_alert: 'compare_prices_proactive',
    event_lookup: 'search_places',       // args get a type:'event' injection
    friend_activity: '__stub__',         // full impl in Phase 3
    set_reminder: '__stub__',            // full impl in Phase 3
}

// ─── Executor ─────────────────────────────────────────────────────────────────

/**
 * Execute an Alpha tool by its schema name.
 *
 * Safely parses and validates raw arguments via Zod (parseToolArgs), then
 * resolves the Alpha name → legacy name and routes through
 * executeThroughSandbox() which enforces rate limiting, timeouts, retries,
 * output compression, and audit logging.
 *
 * @param name    Alpha tool name (e.g. "cab_compare")
 * @param rawArgs Raw JSON string from function.arguments, or a plain object
 * @param userId  Authenticated user ID — required for rate limiting and audit
 * @param config  Optional sandbox overrides (timeout, retries, output size)
 * @returns       ToolExecutionResult from the underlying tool
 */
export async function executeAlphaTool(
    name: string,
    rawArgs: unknown,
    userId = '',
    config?: SandboxConfig,
): Promise<ToolExecutionResult> {
    if (!ALPHA_TOOL_NAMES.has(name)) {
        log.warn({ tool: name }, 'executeAlphaTool called with unknown tool name')
        return { success: false, data: null, error: `Unknown Alpha tool: ${name}` }
    }

    // ── Argument validation ─────────────────────────────────────────────────
    const parsed = parseToolArgs(name, rawArgs)
    if (!parsed.ok) {
        log.warn({ tool: name, reason: parsed.error }, 'argument validation failed')
        return { success: false, data: null, error: parsed.error }
    }
    const args = parsed.args

    const legacyName = ALPHA_TO_LEGACY[name]

    // ── Stubs ──────────────────────────────────────────────────────────────
    if (legacyName === '__stub__') {
        log.info({ tool: name }, 'stub tool called — returning placeholder')
        return buildStubResult(name)
    }

    // ── cab_compare: translate pickup → origin (legacy tool uses origin) ───
    // ── event_lookup: inject type hint ──────────────────────────────────────
    let resolvedArgs = args
    if (name === 'cab_compare') {
        const { pickup, ...rest } = args
        resolvedArgs = { ...rest, origin: pickup }
    } else if (name === 'event_lookup') {
        resolvedArgs = { ...args, query: `events: ${args.query ?? ''}`.trim(), openNow: false }
    }

    log.debug({ tool: name, legacyTool: legacyName }, 'routing through sandbox')

    return executeThroughSandbox(name, { legacyName, args: resolvedArgs }, userId, config)
}

// ─── Stub Helpers ─────────────────────────────────────────────────────────────

function buildStubResult(name: string): ToolExecutionResult {
    const stubs: Record<string, ToolExecutionResult> = {
        friend_activity: {
            success: true,
            data: { status: 'unavailable', message: 'Friend activity is not yet available. Full implementation coming in Phase 3.' },
        },
        set_reminder: {
            success: true,
            data: { status: 'acknowledged', message: 'Reminder noted! Full scheduling will be available soon.' },
        },
    }
    return stubs[name] ?? { success: false, data: null, error: `No stub for: ${name}` }
}
