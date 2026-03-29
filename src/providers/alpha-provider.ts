/**
 * Alpha Provider — High-level abstraction for the user-facing conversational model.
 *
 * Failover chain: Bedrock → Groq Alpha → Together AI → Fireworks AI → Groq (tierManager)
 *
 * Bedrock (Claude Haiku / Sonnet) is the production primary — lowest latency at scale.
 * Groq Alpha (GROQ_ALPHA_API_KEY) is the dev/testing primary and production fallback.
 * Together and Fireworks are secondary fallbacks.
 * Groq tierManager is the final safety net for plain chat only.
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

// ─── Bedrock Alpha (primary — Converse API with tool use) ─────────────────────

const BEDROCK_ALPHA_MODEL = process.env.AWS_BEDROCK_ALPHA_MODEL_ID ?? 'anthropic.claude-3-haiku-20240307-v1:0'

function isBedrockAlphaEnabled(): boolean {
    return process.env.AWS_ENABLED === 'true' && !!process.env.AWS_BEDROCK_REGION
}

function buildBedrockMessages(messages: ChatParams['messages']): any[] {
    const result: any[] = []
    for (const msg of messages) {
        if (msg.role === 'system') continue // system goes in the `system` field
        result.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: [{ text: msg.content || '' }],
        })
    }
    // Bedrock requires alternating user/assistant turns — merge consecutive same-role messages
    const merged: any[] = []
    for (const msg of result) {
        const last = merged[merged.length - 1]
        if (last && last.role === msg.role) {
            last.content.push(...msg.content)
        } else {
            merged.push({ ...msg, content: [...msg.content] })
        }
    }
    return merged
}

async function chatWithBedrock(params: ToolChatParams | ChatParams, withTools: boolean): Promise<{ content: string; toolCalls?: any[]; stopReason: string; latencyMs: number }> {
    const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime')

    const region = process.env.AWS_BEDROCK_REGION ?? process.env.AWS_REGION ?? 'ap-south-1'
    const client = new BedrockRuntimeClient({ region })

    const systemPromptText = params.systemPrompt
        ?? params.messages.find(m => m.role === 'system')?.content

    const converseMessages = buildBedrockMessages(params.messages)

    const input: any = {
        modelId: BEDROCK_ALPHA_MODEL,
        messages: converseMessages,
        inferenceConfig: {
            maxTokens: params.maxTokens ?? 1024,
            temperature: params.temperature ?? 0.3,
        },
    }

    if (systemPromptText) {
        input.system = [{ text: systemPromptText }]
    }

    if (withTools) {
        const toolParams = params as ToolChatParams
        input.toolConfig = {
            tools: toolParams.tools.map(t => ({
                toolSpec: {
                    name: t.function.name,
                    description: t.function.description ?? '',
                    inputSchema: { json: t.function.parameters },
                },
            })),
        }
    }

    const start = Date.now()
    const command = new ConverseCommand(input)
    const response = await client.send(command)
    const latencyMs = Date.now() - start

    const contentBlocks: any[] = response.output?.message?.content ?? []
    const textBlock = contentBlocks.find((b: any) => b.text)?.text ?? ''

    const toolCalls = contentBlocks
        .filter((b: any) => b.toolUse)
        .map((b: any) => ({
            id: b.toolUse.toolUseId,
            function: {
                name: b.toolUse.name,
                arguments: JSON.stringify(b.toolUse.input ?? {}),
            },
        }))

    const stopReason = response.stopReason === 'tool_use' ? 'tool_use'
        : response.stopReason === 'max_tokens' ? 'length'
        : 'stop'

    return { content: textBlock, toolCalls, stopReason, latencyMs }
}

// ─── Groq Alpha (dev primary / production fallback) ──────────────────────────

const GROQ_ALPHA_BASE = 'https://api.groq.com/openai/v1'
const GROQ_ALPHA_MODEL = process.env.GROQ_ALPHA_MODEL ?? 'llama-3.3-70b-versatile'

function isGroqAlphaEnabled(): boolean {
    return !!process.env.GROQ_ALPHA_API_KEY
}

async function chatWithGroqAlpha(params: ToolChatParams | ChatParams, withTools: boolean): Promise<{ content: string; toolCalls?: any[]; stopReason: string; latencyMs: number }> {
    const apiKey = process.env.GROQ_ALPHA_API_KEY!
    const messages: any[] = []

    if (params.systemPrompt) {
        messages.push({ role: 'system', content: params.systemPrompt })
    }
    for (const msg of params.messages) {
        if (msg.role === 'system' && params.systemPrompt) continue
        messages.push({ role: msg.role, content: msg.content })
    }

    const body: any = {
        model: GROQ_ALPHA_MODEL,
        messages,
        max_tokens: params.maxTokens ?? 1024,
        temperature: params.temperature ?? 0.3,
    }

    if (withTools) {
        const toolParams = params as ToolChatParams
        body.tools = toolParams.tools.map(t => ({ type: 'function', function: t.function }))
        body.tool_choice = toolParams.toolChoice ?? 'auto'
        body.parallel_tool_calls = toolParams.parallelToolCalls ?? true
    }

    const start = Date.now()
    const resp = await fetch(`${GROQ_ALPHA_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    })

    if (!resp.ok) {
        const text = await resp.text()
        throw new Error(`Groq Alpha ${resp.status}: ${text.slice(0, 200)}`)
    }

    const data = await resp.json() as any
    const choice = data.choices?.[0]
    const content: string = choice?.message?.content ?? ''
    const toolCalls = (choice?.message?.tool_calls ?? []).map((tc: any) => ({
        id: tc.id,
        function: { name: tc.function.name, arguments: tc.function.arguments },
    }))
    const stopReason = choice?.finish_reason === 'tool_calls' ? 'tool_use'
        : choice?.finish_reason === 'length' ? 'length'
        : 'stop'

    return { content, toolCalls, stopReason, latencyMs: Date.now() - start }
}

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
     * Chain: Bedrock → Groq Alpha → Together → Fireworks → throws
     */
    async chatWithTools(params: ToolChatParams): Promise<ToolChatResponse> {
        // Bedrock (primary)
        if (isBedrockAlphaEnabled()) {
            const start = Date.now()
            try {
                const result = await chatWithBedrock(params, true)
                log.info({ provider: 'bedrock-alpha', latencyMs: Date.now() - start }, 'alpha call')
                return {
                    content: result.content,
                    toolCalls: result.toolCalls ?? [],
                    stopReason: result.stopReason as ToolChatResponse['stopReason'],
                    usage: { inputTokens: 0, outputTokens: 0 },
                    latencyMs: result.latencyMs,
                }
            } catch (err) {
                log.warn({ provider: 'bedrock-alpha', err }, 'bedrock failed — trying groq alpha')
            }
        }

        // Groq Alpha (dev primary / production fallback)
        if (isGroqAlphaEnabled()) {
            const start = Date.now()
            try {
                const result = await chatWithGroqAlpha(params, true)
                log.info({ provider: 'groq-alpha', latencyMs: Date.now() - start }, 'alpha call')
                return {
                    content: result.content,
                    toolCalls: result.toolCalls ?? [],
                    stopReason: result.stopReason as ToolChatResponse['stopReason'],
                    usage: { inputTokens: 0, outputTokens: 0 },
                    latencyMs: result.latencyMs,
                }
            } catch (err) {
                log.warn({ provider: 'groq-alpha', err }, 'groq alpha failed — trying together')
            }
        }

        // Together
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

        // Fireworks
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

        throw new Error('[AlphaProvider] No provider available for chatWithTools — all providers failed or unconfigured')
    }

    /**
     * Plain chat (no tools).
     * Chain: Bedrock → Groq Alpha → Together → Fireworks → Groq (tierManager)
     */
    async chat(params: ChatParams): Promise<ChatResponse> {
        // Bedrock (primary)
        if (isBedrockAlphaEnabled()) {
            const start = Date.now()
            try {
                const result = await chatWithBedrock(params, false)
                log.info({ provider: 'bedrock-alpha', latencyMs: Date.now() - start }, 'alpha call')
                return { content: result.content, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: result.latencyMs }
            } catch (err) {
                log.warn({ provider: 'bedrock-alpha', err }, 'bedrock failed — trying groq alpha')
            }
        }

        // Groq Alpha (dev primary / production fallback)
        if (isGroqAlphaEnabled()) {
            const start = Date.now()
            try {
                const result = await chatWithGroqAlpha(params, false)
                log.info({ provider: 'groq-alpha', latencyMs: Date.now() - start }, 'alpha call')
                return { content: result.content, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: result.latencyMs }
            } catch (err) {
                log.warn({ provider: 'groq-alpha', err }, 'groq alpha failed — trying together')
            }
        }

        // Together
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

        // Fireworks
        if (await this.fireworks.isAvailable()) {
            const start = Date.now()
            try {
                const result = await this.fireworks.chat(params)
                log.info({ provider: 'fireworks', latencyMs: Date.now() - start }, 'alpha call')
                return result
            } catch (err) {
                log.warn({ provider: 'fireworks', err }, 'fireworks failed — falling back to groq tierManager')
            }
        }

        // Groq tierManager (final safety net)
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
