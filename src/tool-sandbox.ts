/**
 * Alpha Tool Sandbox (#129)
 *
 * executeThroughSandbox() is the single gated execution layer for all Alpha
 * tool calls.  It is called by executeAlphaTool() in tool-executor.ts after
 * name-mapping; it MUST NOT be bypassed.
 *
 * Enforces, in order:
 *   1. Rate limiting      — per-user per-minute cap (rate_limits table)
 *   2. Timeout            — hard deadline per call
 *   3. Retries            — exponential backoff on transient failures
 *   4. Output compression — truncates oversized payloads before LLM injection
 *   5. Audit logging      — every call is written to tool_log (non-blocking)
 *
 * Schema validation (tool name) is done upstream in executeAlphaTool().
 */

import { logger as rootLogger } from './logger.js'
import { checkRateLimit, getPool } from './character/session-store.js'
import { bodyHooks } from './tools/index.js'
import type { ToolExecutionResult } from './hooks.js'

const log = rootLogger.child({ module: 'tool-sandbox' })

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS    = 15_000   // 15 s hard deadline per tool call
const DEFAULT_MAX_RETRIES   = 2        // 3 total attempts
const DEFAULT_MAX_OUT_BYTES = 20_000   // 20 KB — keeps LLM context lean

// ─── Public Types ──────────────────────────────────────────────────────────────

/** Resolved tool call after Alpha→legacy name mapping */
export interface ResolvedToolCall {
    /** Legacy tool name as registered in bodyHooks (e.g. "compare_rides") */
    legacyName: string
    /** Arguments, fully coerced and ready for the underlying tool */
    args: Record<string, unknown>
}

export interface SandboxConfig {
    /** Per-call timeout in milliseconds (default: 15 000) */
    timeoutMs?: number
    /** Maximum retry attempts after the first failure (default: 2) */
    maxRetries?: number
    /** Maximum allowed output payload in bytes before truncation (default: 20 000) */
    maxOutputBytes?: number
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

/**
 * Execute a resolved (name-mapped) tool call through the full sandbox.
 *
 * @param alphaName   Original Alpha tool name — used for logging and audit only
 * @param toolCall    Resolved legacy name + coerced args
 * @param userId      Authenticated user ID (rate limiting + audit)
 * @param config      Optional overrides for timeout / retries / output size
 */
export async function executeThroughSandbox(
    alphaName: string,
    toolCall: ResolvedToolCall,
    userId: string,
    config?: SandboxConfig,
): Promise<ToolExecutionResult> {
    const { legacyName, args } = toolCall
    const timeoutMs   = config?.timeoutMs      ?? DEFAULT_TIMEOUT_MS
    const maxRetries  = config?.maxRetries     ?? DEFAULT_MAX_RETRIES
    const maxOutBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUT_BYTES

    // ── 1. Rate limiting ──────────────────────────────────────────────────────
    const allowed = await checkRateLimit(userId).catch(err => {
        // Fail-open: a broken DB must not block the user, but we log it.
        log.error({ userId, err }, 'rate-limit check failed — allowing (fail-open)')
        return true
    })
    if (!allowed) {
        log.warn({ tool: alphaName, userId }, 'rate limit exceeded')
        return {
            success: false,
            data: null,
            error: 'Rate limit exceeded. Please try again in a minute.',
        }
    }

    // ── 2. Timeout + 3. Retries ───────────────────────────────────────────────
    const start = Date.now()
    let result: ToolExecutionResult | undefined
    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            result = await withTimeout(
                bodyHooks.executeTool(legacyName, args),
                timeoutMs,
                alphaName,
            )
            break  // success — exit retry loop
        } catch (err) {
            lastError = err
            if (attempt < maxRetries) {
                const delayMs = 500 * 2 ** attempt  // 500 ms → 1 000 ms
                log.warn({ tool: alphaName, userId, attempt, delayMs }, 'sandbox retrying')
                await sleep(delayMs)
            }
        }
    }

    if (result === undefined) {
        const msg = lastError instanceof Error ? lastError.message : 'Tool execution failed'
        result = { success: false, data: null, error: msg }
    }

    // ── 4. Output compression ─────────────────────────────────────────────────
    result = compressOutput(result, maxOutBytes, alphaName)

    const latencyMs = Date.now() - start

    // ── 5. Audit logging (non-blocking — must never throw) ────────────────────
    auditLog({
        userId,
        alphaName,
        legacyName,
        args,
        result,
        latencyMs,
    }).catch(err => log.error({ err }, 'tool_log write failed — non-fatal'))

    log.debug({ tool: alphaName, userId, success: result.success, latencyMs }, 'sandbox done')
    return result
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Tool timed out after ${ms}ms: ${label}`)),
            ms,
        )
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Truncate oversized tool output so it never blows the LLM context window.
 * Wraps the raw data in a _truncated envelope so downstream code can detect it.
 */
function compressOutput(
    result: ToolExecutionResult,
    maxBytes: number,
    label: string,
): ToolExecutionResult {
    if (!result.data) return result
    const serialized = JSON.stringify(result.data)
    if (serialized.length <= maxBytes) return result
    log.debug({ tool: label, originalBytes: serialized.length, maxBytes }, 'output compressed')
    return {
        ...result,
        data: {
            _truncated: true,
            _originalBytes: serialized.length,
            preview: serialized.slice(0, maxBytes),
        },
    }
}

async function auditLog(entry: {
    userId: string
    alphaName: string
    legacyName: string
    args: Record<string, unknown>
    result: ToolExecutionResult
    latencyMs: number
}): Promise<void> {
    const db = getPool()
    await db.query(
        `INSERT INTO tool_log
            (user_id, tool_name, parameters, result, success, error_message, execution_time_ms)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
        [
            entry.userId,
            entry.alphaName,
            JSON.stringify(entry.args),
            JSON.stringify(entry.result.data),
            entry.result.success,
            entry.result.error ?? null,
            entry.latencyMs,
        ],
    )
}
