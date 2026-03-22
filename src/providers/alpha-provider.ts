/**
 * Alpha Provider — High-level abstraction for the user-facing 70B model.
 *
 * Failover chain: Together AI → Fireworks AI → Groq (via tierManager)
 *
 * Together is preferred for its function calling accuracy and 600 rpm ceiling.
 * Fireworks is the second tier. Groq (existing tierManager) is the safety net.
 *
 * Usage:
 *   const alpha = new AlphaProvider()
 *   const result = await alpha.chatWithTools({ messages, tools, systemPrompt })
 *   // or for plain chat:
 *   const result = await alpha.chat({ messages, systemPrompt })
 */

import { logger as rootLogger } from '../logger.js'
import { TogetherProvider } from '../llm/providers/together.js'
import { FireworksProvider } from '../llm/providers/fireworks.js'
import { generateResponse, type ChatMessage, type CallOptions } from '../llm/tierManager.js'
import type {
    LLMProviderWithTools,
    ChatParams,
    ChatResponse,
    ToolChatParams,
    ToolChatResponse,
} from '../llm/providers/types.js'

const log = rootLogger.child({ module: 'alpha-provider' })

// ─── AlphaProvider ───────────────────────────────────────────────────────────

export class AlphaProvider {
    private readonly together: LLMProviderWithTools
    private readonly fireworks: LLMProviderWithTools

    constructor() {
        this.together = new TogetherProvider()
        this.fireworks = new FireworksProvider()
    }

    /**
     * Chat with function calling support.
     * Tries Together → Fireworks → throws (caller falls back to Groq plain chat).
     */
    async chatWithTools(params: ToolChatParams): Promise<ToolChatResponse> {
        // Together first
        if (await this.together.isAvailable()) {
            const start = Date.now()
            try {
                const result = await this.together.chatWithTools(params)
                log.info({ provider: 'together', latencyMs: Date.now() - start }, 'alpha call')
                return result
            } catch (err) {
                log.warn({ provider: 'together', err }, 'together failed — trying fireworks')
            }
        }

        // Fireworks fallback
        if (await this.fireworks.isAvailable()) {
            const start = Date.now()
            try {
                const result = await this.fireworks.chatWithTools(params)
                log.info({ provider: 'fireworks', latencyMs: Date.now() - start }, 'alpha call')
                return result
            } catch (err) {
                log.warn({ provider: 'fireworks', err }, 'fireworks failed')
            }
        }

        throw new Error('[AlphaProvider] No provider available for chatWithTools — Together and Fireworks both failed or unconfigured')
    }

    /**
     * Plain chat (no tools). Tries Together → Fireworks → Groq (tierManager).
     */
    async chat(params: ChatParams): Promise<ChatResponse> {
        // Together first
        if (await this.together.isAvailable()) {
            const start = Date.now()
            try {
                const result = await this.together.chat(params)
                log.info({ provider: 'together', latencyMs: Date.now() - start }, 'alpha call')
                return result
            } catch (err) {
                log.warn({ provider: 'together', err }, 'together failed — trying fireworks')
            }
        }

        // Fireworks fallback
        if (await this.fireworks.isAvailable()) {
            const start = Date.now()
            try {
                const result = await this.fireworks.chat(params)
                log.info({ provider: 'fireworks', latencyMs: Date.now() - start }, 'alpha call')
                return result
            } catch (err) {
                log.warn({ provider: 'fireworks', err }, 'fireworks failed — falling back to groq')
            }
        }

        // Groq fallback via existing tierManager
        const start = Date.now()
        const groqMessages = buildGroqMessages(params)
        const groqOpts = buildGroqOpts(params)
        const { text, provider } = await generateResponse(groqMessages, groqOpts)
        log.info({ provider, latencyMs: Date.now() - start }, 'alpha call')

        return {
            content: text,
            usage: { inputTokens: 0, outputTokens: 0 },
            latencyMs: Date.now() - start,
        }
    }
}

// ─── Groq Adapter Helpers ────────────────────────────────────────────────────

function buildGroqMessages(params: ChatParams): ChatMessage[] {
    const messages: ChatMessage[] = []

    if (params.systemPrompt) {
        messages.push({ role: 'system', content: params.systemPrompt })
    }

    for (const msg of params.messages) {
        if (msg.role === 'tool') continue // Groq tierManager doesn't handle tool results
        messages.push({ role: msg.role as ChatMessage['role'], content: msg.content })
    }

    return messages
}

function buildGroqOpts(params: ChatParams): CallOptions {
    return {
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        jsonMode: params.jsonMode,
    }
}
