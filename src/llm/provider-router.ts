/**
 * ProviderRouter — Circuit-breaker fallback chain for LLM providers.
 *
 * Tries each provider in order. Tracks errors per provider in a rolling
 * 60-second window. A provider is "tripped" (skipped) when it accumulates
 * more than ERROR_THRESHOLD errors within the window.
 *
 * Tripped providers are automatically reset after the window expires,
 * giving them a chance to recover before being tried again.
 *
 * Usage:
 *   const router = new ProviderRouter([togetherProvider, fireworksProvider])
 *   const response = await router.chatWithTools(params)  // auto-fails over on error
 */

import { logger as rootLogger } from '../logger.js'
import type { LLMProviderWithTools, ChatParams, ChatResponse, ToolChatParams, ToolChatResponse } from './providers/types.js'

const log = rootLogger.child({ module: 'provider-router' })

// ─── Constants ──────────────────────────────────────────────────────────────

const ERROR_THRESHOLD = 5
const WINDOW_MS = 60_000

// ─── Internal State ──────────────────────────────────────────────────────────

interface ProviderState {
    provider: LLMProviderWithTools
    errorCount: number
    windowStart: number
    tripped: boolean
}

// ─── ProviderRouter ──────────────────────────────────────────────────────────

export class ProviderRouter implements LLMProviderWithTools {
    name = 'provider-router'

    private readonly states: ProviderState[]
    private readonly errorThreshold: number
    private readonly windowMs: number

    constructor(
        providers: LLMProviderWithTools[],
        opts?: { errorThreshold?: number; windowMs?: number }
    ) {
        if (providers.length === 0) throw new Error('[ProviderRouter] At least one provider required')

        this.errorThreshold = opts?.errorThreshold ?? ERROR_THRESHOLD
        this.windowMs = opts?.windowMs ?? WINDOW_MS
        this.states = providers.map(p => ({
            provider: p,
            errorCount: 0,
            windowStart: Date.now(),
            tripped: false,
        }))
    }

    async isAvailable(): Promise<boolean> {
        for (const state of this.states) {
            if (await state.provider.isAvailable()) return true
        }
        return false
    }

    async chat(params: ChatParams): Promise<ChatResponse> {
        let lastErr: Error | undefined

        for (const state of this.states) {
            if (this.isTripped(state)) {
                log.debug({ provider: state.provider.name }, 'circuit open — skipping provider')
                continue
            }
            if (!await state.provider.isAvailable()) continue

            try {
                return await state.provider.chat(params)
            } catch (err) {
                lastErr = err as Error
                this.recordError(state)
                log.warn({ provider: state.provider.name, errorCount: state.errorCount, err }, 'provider error — trying next')
            }
        }

        throw new Error(`[ProviderRouter] All providers failed or tripped: ${lastErr?.message ?? 'unknown'}`)
    }

    async chatWithTools(params: ToolChatParams): Promise<ToolChatResponse> {
        let lastErr: Error | undefined

        for (const state of this.states) {
            if (this.isTripped(state)) {
                log.debug({ provider: state.provider.name }, 'circuit open — skipping provider')
                continue
            }
            if (!await state.provider.isAvailable()) continue

            try {
                return await state.provider.chatWithTools(params)
            } catch (err) {
                lastErr = err as Error
                this.recordError(state)
                log.warn({ provider: state.provider.name, errorCount: state.errorCount, err }, 'provider error — trying next')
            }
        }

        throw new Error(`[ProviderRouter] All providers failed or tripped: ${lastErr?.message ?? 'unknown'}`)
    }

    // ─── Circuit Breaker ──────────────────────────────────────────────────────

    private resetIfExpired(state: ProviderState): void {
        if (Date.now() - state.windowStart > this.windowMs) {
            if (state.tripped) {
                log.info({ provider: state.provider.name }, 'circuit reset — window expired')
            }
            state.errorCount = 0
            state.windowStart = Date.now()
            state.tripped = false
        }
    }

    private recordError(state: ProviderState): void {
        this.resetIfExpired(state)
        state.errorCount++
        if (state.errorCount >= this.errorThreshold) {
            if (!state.tripped) {
                log.warn(
                    { provider: state.provider.name, errorCount: state.errorCount, thresholdMs: this.windowMs },
                    'circuit tripped — provider will be skipped until window resets'
                )
            }
            state.tripped = true
        }
    }

    private isTripped(state: ProviderState): boolean {
        this.resetIfExpired(state)
        return state.tripped
    }
}
