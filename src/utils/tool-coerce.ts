/**
 * Tool Argument Coercion + Simple-Message Fast-Paths (Unit 10 extraction)
 *
 * Extracted from cognitive.ts during the Fusion Architecture refactor.
 * These pure utilities no longer belong to the 8B classifier layer — they
 * are general-purpose helpers used by both the Alpha pipeline and the
 * legacy tool executor.
 */

import type { ClassifierResult } from '../types/cognitive.js'
import { getGroqTools } from '../tools/index.js'

// ─── Type Coercion ────────────────────────────────────────────────────────────

/**
 * Groq 8B sometimes emits numbers as strings (e.g. "amount": "100").
 * Coerce values to the types declared in the tool schemas so tools don't break.
 */
export function coerceToolArgs(
    toolName: string,
    args: Record<string, unknown>
): Record<string, unknown> {
    const tools = getGroqTools()
    const tool = tools.find(t => t.function.name === toolName)
    if (!tool?.function.parameters) return args

    const props = (tool.function.parameters as any)?.properties
    if (!props) return args

    const coerced = { ...args }
    for (const [key, schema] of Object.entries(props) as [string, any][]) {
        if (key in coerced && schema.type === 'number' && typeof coerced[key] === 'string') {
            const num = Number(coerced[key])
            if (!isNaN(num)) {
                coerced[key] = num
            }
        }
    }
    return coerced
}

// ─── Simple-Message Fast-Paths ────────────────────────────────────────────────

const SIMPLE_PATTERNS = [
    /^(hi|hey|hello|hola|yo|sup|hii+|heyy+)[\s!.]*$/,
    /^(bye|goodbye|see ya|later|ciao|tata)[\s!.]*$/,
    /^(thanks|thank you|thx|ty|merci)[\s!.]*$/,
    /^(yes|no|yep|nope|yeah|nah|yea|ok|okay|sure|alright|k|kk)[\s!.]*$/,
    /^(good|great|nice|cool|awesome|perfect|fine|hmm+|haha|lol|lmao)[\s!.]*$/,
    /^(gm|gn|good morning|good night|good evening)[\s!.]*$/,
]

/**
 * Regex check for obviously simple messages (zero LLM cost).
 * The caller must pass a trimmed, lower-cased string.
 */
export function isObviouslySimple(msg: string): boolean {
    return SIMPLE_PATTERNS.some(p => p.test(msg))
}

/** Classification result for obviously simple messages (greeting, ack, etc.). */
export function getSimpleClassification(): ClassifierResult {
    return {
        message_complexity: 'simple',
        needs_tool: false,
        tool_hint: null,
        tool_args: {},
        skip_memory: true,
        skip_graph: true,
        skip_cognitive: true,
    }
}

/** Default classification for moderate messages (no LLM call needed). */
export function getDefaultClassification(): ClassifierResult {
    return {
        message_complexity: 'moderate',
        needs_tool: false,
        tool_hint: null,
        tool_args: {},
        skip_memory: false,
        skip_graph: false,
        skip_cognitive: false,
        userSignal: 'normal',
        detected_topic: null,
        interest_signal: 'neutral',
        cognitiveState: {
            internalMonologue: 'Processing user request in Aria voice.',
            emotionalState: 'curious',
            conversationGoal: 'inform',
            relevantMemories: [],
        },
    }
}
