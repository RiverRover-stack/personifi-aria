/**
 * Plan Extractor — extracts concrete plans from session summaries
 * and writes them to conversation_plans for future Sentinel stimulus firing.
 */

import { getPool } from '../character/session-store.js'
import { generateResponse } from '../llm/tierManager.js'
import { logger } from '../logger.js'

const log = logger.child({ module: 'archivist/plan-extractor' })

const PLAN_TYPES = ['outing', 'travel', 'food', 'study', 'purchase', 'event', 'other'] as const

/**
 * Build the extraction prompt with today's IST date injected so the LLM can
 * resolve relative day references ("Thursday", "next week", "tomorrow") to
 * absolute ISO dates. Without this anchor the model returns scheduled_for: null
 * and the 5-day fallback fires after the event has already passed.
 */
function buildExtractionPrompt(): string {
    const now = new Date()
    // IST = UTC + 5:30
    const ist = new Date(now.getTime() + 330 * 60 * 1000)
    const todayIST = ist.toISOString().split('T')[0]
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const todayDayName = dayNames[ist.getUTCDay()]

    return `You are a plan extraction engine. Extract concrete plans or intentions from the conversation summary below.

Today's date is ${todayIST} (${todayDayName} IST). Use this to resolve relative day references like "Thursday", "next week", "tomorrow" into absolute ISO date strings (YYYY-MM-DD).

Return ONLY valid JSON in this exact format:
{ "plans": [], "has_topic_interest": false }

For each plan found, add an object with:
  - plan_type: one of "outing", "travel", "food", "study", "purchase", "event", "other"
  - description: human-readable description (e.g. "Visit Hampi next month")
  - scheduled_for: ISO date string (YYYY-MM-DD) resolved from today's date if a day/date was mentioned, otherwise null
  - participants: array of participant names mentioned, otherwise []

Set has_topic_interest to true if the user showed strong interest in a topic (movie, course, event, etc.) even without a concrete plan.

Only extract explicitly mentioned plans. Do not infer. Return valid JSON only.`
}

interface ExtractedPlan {
    plan_type: string
    description: string
    scheduled_for: string | null
    participants: string[]
}

interface ExtractionResult {
    plans: ExtractedPlan[]
    has_topic_interest: boolean
}

/**
 * Extract plans from a session summary and write them to conversation_plans.
 * Also sets has_topic_interest metadata on the session_summaries row.
 * Fire-and-forget safe — never throws.
 */
export async function extractPlansFromSummary(
    userId: string,
    sessionId: string,
    summaryText: string,
): Promise<void> {
    try {
        const { text: raw } = await generateResponse([
            { role: 'system', content: buildExtractionPrompt() },
            { role: 'user', content: `Extract plans from this summary:\n\n${summaryText}` },
        ], { maxTokens: 400, temperature: 0.1, jsonMode: true })

        if (!raw) return

        let result: ExtractionResult
        try {
            result = JSON.parse(raw) as ExtractionResult
        } catch {
            log.warn({ sessionId, raw: raw.slice(0, 200) }, 'Plan extraction JSON parse failed')
            return
        }

        const pool = getPool()

        // Write extracted plans
        if (Array.isArray(result.plans) && result.plans.length > 0) {
            for (const plan of result.plans) {
                const planType = PLAN_TYPES.includes(plan.plan_type as any) ? plan.plan_type : 'other'
                await pool.query(
                    `INSERT INTO conversation_plans
                         (user_id, session_id, plan_type, description, scheduled_for, participants, source_summary, expires_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '7 days')
                     ON CONFLICT DO NOTHING`,
                    [
                        userId,
                        sessionId,
                        planType,
                        plan.description,
                        plan.scheduled_for ?? null,
                        plan.participants ?? [],
                        summaryText.slice(0, 500),
                    ],
                )
            }
            log.info({ userId, sessionId, planCount: result.plans.length }, 'Plans extracted')
        }

        // Update session_summaries with has_topic_interest flag
        if (result.has_topic_interest) {
            await pool.query(
                `UPDATE session_summaries
                 SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"has_topic_interest": "true"}'::jsonb
                 WHERE session_id = $1`,
                [sessionId],
            ).catch(err => log.warn({ err, sessionId }, 'Failed to set has_topic_interest flag'))
        }
    } catch (err) {
        log.warn({ err, userId, sessionId }, 'Plan extraction failed (non-fatal)')
    }
}
