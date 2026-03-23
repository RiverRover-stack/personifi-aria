/**
 * Shared types for LLM providers (Together, Fireworks, Bedrock, etc.)
 *
 * All providers in src/llm/providers/ implement these interfaces.
 * ProviderRouter and higher-level wrappers (AlphaProvider, SentinelProvider)
 * depend only on these contracts, not on concrete implementations.
 */

// ─── Message Types ────────────────────────────────────────────────────────────

export interface ProviderMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    /** Present on tool-result messages */
    tool_call_id?: string
}

// ─── Tool Schema (Groq / OpenAI compatible) ───────────────────────────────────

export interface ToolFunction {
    name: string
    description: string
    parameters: Record<string, unknown>
}

export interface ProviderTool {
    type: 'function'
    function: ToolFunction
}

export interface ToolCallResult {
    id: string
    function: {
        name: string
        /** Raw JSON string of arguments */
        arguments: string
    }
}

// ─── Request Params ───────────────────────────────────────────────────────────

export interface ChatParams {
    messages: ProviderMessage[]
    systemPrompt?: string
    model?: string
    maxTokens?: number
    temperature?: number
    /** Force the model to return a JSON object */
    jsonMode?: boolean
}

export interface ToolChatParams extends ChatParams {
    tools: ProviderTool[]
    toolChoice?: 'auto' | 'none' | 'required'
    parallelToolCalls?: boolean
}

// ─── Response Types ───────────────────────────────────────────────────────────

export interface UsageStats {
    inputTokens: number
    outputTokens: number
}

export interface ChatResponse {
    content: string
    usage: UsageStats
    latencyMs: number
}

export interface ToolChatResponse extends ChatResponse {
    toolCalls: ToolCallResult[]
    stopReason: 'stop' | 'tool_use' | 'length'
}

// ─── Provider Interface ───────────────────────────────────────────────────────

export interface LLMProviderWithTools {
    name: string
    isAvailable(): Promise<boolean>
    chat(params: ChatParams): Promise<ChatResponse>
    chatWithTools(params: ToolChatParams): Promise<ToolChatResponse>
}
