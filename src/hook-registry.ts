/**
 * Hook Registry — Singleton for Dev 1 + Dev 2 hook registration (Unit 10 refactor)
 *
 * Dev 1 calls: registerBrainHooks(myBrainHooks)
 * Dev 2 calls: registerBodyHooks(myBodyHooks)
 * Handler calls: getBrainHooks() / getBodyHooks()
 *
 * executeToolPipeline() no longer routes through Scout's cache/reflection layer.
 * Tool calls are dispatched directly to bodyHooks.executeTool() so the 70B model
 * response becomes the only "reflection". Tool results are persisted to the
 * tool_results table by the Alpha caller before this is invoked.
 *
 * If no hooks are registered, defaults are returned (no-ops).
 */

import type { BrainHooks, BodyHooks, RouteDecision, RouteContext, ToolResult } from './hooks.js'
import { defaultBrainHooks, defaultBodyHooks } from './hooks.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'hook-registry' })

// ─── Singleton State ─────────────────────────────────────────────────────────

let brainHooks: BrainHooks = defaultBrainHooks
let bodyHooks: BodyHooks   = defaultBodyHooks

// ─── Registration ────────────────────────────────────────────────────────────

/** Dev 1 calls this to register brain/router hooks */
export function registerBrainHooks(hooks: BrainHooks): void {
    brainHooks = hooks
    log.info('Brain hooks registered')
}

/** Dev 2 calls this to register body/tool hooks */
export function registerBodyHooks(hooks: BodyHooks): void {
    bodyHooks = hooks
    log.info('Body hooks registered')
}

// ─── Tool Execution (Scout removed — direct dispatch) ────────────────────────

/**
 * Execute a tool decision directly through the Body's executeTool() hook.
 * The scout caching/reflection layer has been removed in Unit 10.
 * Returns a ToolResult-shaped object compatible with the handler's expectations.
 */
async function executeDirectPipeline(
    decision: RouteDecision,
    _context: RouteContext,
): Promise<ToolResult | null> {
    if (!decision.useTool || !decision.toolName) return null

    const execResult = await bodyHooks.executeTool(decision.toolName, decision.toolParams)
    if (!execResult.success) {
        log.warn({ tool: decision.toolName, error: execResult.error }, 'Tool execution failed')
        return null
    }

    const formatted = typeof execResult.data === 'string'
        ? execResult.data
        : JSON.stringify(execResult.data)

    return {
        success: true,
        data: formatted,
        raw: execResult.data,
    }
}

// ─── Retrieval ───────────────────────────────────────────────────────────────

/** Handler calls this to get the current brain hooks (or defaults) */
export function getBrainHooks(): BrainHooks {
    return {
        ...brainHooks,
        executeToolPipeline: executeDirectPipeline,
    }
}

/** Handler calls this to get the current body hooks (or defaults) */
export function getBodyHooks(): BodyHooks {
    return bodyHooks
}
