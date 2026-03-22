/**
 * Alpha Tool Argument Schemas (#129)
 *
 * Zod schemas that mirror the JSON Schema definitions in tool-definitions.ts.
 * parseToolArgs() is the single safe-parse entry-point used by executeAlphaTool()
 * before any execution path is reached.
 *
 * Accepts a raw JSON string (as returned in function.arguments by provider APIs)
 * or an already-parsed object.  Never throws.
 */

import { z } from 'zod'

// ─── Schemas ───────────────────────────────────────────────────────────────────

const SCHEMAS: Record<string, z.ZodType> = {
    cab_compare: z.object({
        pickup:      z.string().min(1),
        destination: z.string().min(1),
        passengers:  z.number().int().min(1).optional(),
    }),

    place_search: z.object({
        query:     z.string().min(1),
        location:  z.string().optional(),
        openNow:   z.boolean().optional(),
        minRating: z.number().min(1).max(5).optional(),
    }),

    weather_check: z.object({
        location: z.string().min(1),
    }),

    food_finder: z.object({
        query:    z.string().min(1),
        location: z.string().min(1),
    }),

    price_alert: z.object({
        query:    z.string().min(1),
        location: z.string().optional(),
        category: z.enum(['grocery', 'snacks', 'beverages', 'personal_care', 'other']).optional(),
    }),

    event_lookup: z.object({
        query:    z.string().min(1),
        location: z.string().min(1),
        date:     z.string().optional(),
    }),

    friend_activity: z.object({
        friendId: z.string().min(1),
    }),

    set_reminder: z.object({
        message: z.string().min(1),
        time:    z.string().min(1),
    }),
}

// ─── Public API ────────────────────────────────────────────────────────────────

export type ParseResult =
    | { ok: true;  args: Record<string, unknown> }
    | { ok: false; error: string }

/**
 * Safely parse and validate raw tool arguments.
 *
 * @param toolName  Alpha tool name (e.g. "cab_compare")
 * @param raw       Raw JSON string from function.arguments, or a plain object
 */
export function parseToolArgs(toolName: string, raw: unknown): ParseResult {
    // 1. JSON-decode if the provider sent a raw string
    let candidate: unknown = raw
    if (typeof raw === 'string') {
        try {
            candidate = JSON.parse(raw)
        } catch {
            return { ok: false, error: `Invalid JSON in function.arguments for "${toolName}"` }
        }
    }

    // 2. Validate and coerce through the Zod schema
    const schema = SCHEMAS[toolName]
    if (!schema) {
        return { ok: false, error: `No argument schema registered for "${toolName}"` }
    }

    const result = schema.safeParse(candidate)
    if (!result.success) {
        return { ok: false, error: `Argument validation failed for "${toolName}": ${result.error.message}` }
    }

    return { ok: true, args: result.data as Record<string, unknown> }
}
