/**
 * Alpha Tool Executor (#129)
 *
 * Maps Alpha tool names → existing tool implementations in src/tools/index.ts.
 * This is the only file that knows the name mapping between Alpha's curated
 * schema names and the legacy tool registry names.
 *
 * Dev3's tool-sandbox.ts calls sandboxToolCall() before reaching here.
 * This file does NOT validate — it only executes.
 */

import { logger as rootLogger } from './logger.js'
import { bodyHooks } from './tools/index.js'
import { ALPHA_TOOL_NAMES } from './tool-definitions.js'
import type { ToolExecutionResult } from './hooks.js'

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
 * @param name   Alpha tool name (e.g. "cab_compare")
 * @param args   Validated, coerced arguments from the sandbox
 * @returns      ToolExecutionResult from the underlying tool
 */
export async function executeAlphaTool(
    name: string,
    args: Record<string, unknown>
): Promise<ToolExecutionResult> {
    if (!ALPHA_TOOL_NAMES.has(name)) {
        log.warn({ tool: name }, 'executeAlphaTool called with unknown tool name')
        return { success: false, data: null, error: `Unknown Alpha tool: ${name}` }
    }

    const legacyName = ALPHA_TO_LEGACY[name]

    // ── Stubs ──────────────────────────────────────────────────────────────
    if (legacyName === '__stub__') {
        log.info({ tool: name }, 'stub tool called — returning placeholder')
        return buildStubResult(name)
    }

    // ── event_lookup: inject type hint ──────────────────────────────────────
    const resolvedArgs = name === 'event_lookup'
        ? { ...args, query: `events: ${args.query ?? ''}`.trim(), openNow: false }
        : args

    const start = Date.now()
    log.debug({ tool: name, legacyTool: legacyName }, 'executing')

    try {
        const result = await bodyHooks.executeTool(legacyName, resolvedArgs)
        log.debug({ tool: name, success: result.success, latencyMs: Date.now() - start }, 'done')
        return result
    } catch (err) {
        log.error({ tool: name, err }, 'tool execution threw unexpectedly')
        return { success: false, data: null, error: `Tool execution failed: ${name}` }
    }
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
