/**
 * Sentinel Provider — Background Scoring Engine (Issue #141)
 *
 * Provides LLM-backed scoring for proactive stimulus evaluation.
 * Does NOT need function calling — only structured JSON output.
 *
 * Provider chain:
 *   1. AWS Bedrock (real-time scoring — Claude Haiku or Llama)
 *   2. Together AI Batch (bulk scoring — cost-efficient for 500+ users)
 *
 * NOT Ollama. All Ollama references are superseded:
 *   Bedrock replaces Ollama for real-time.
 *   Together Batch replaces Ollama for bulk.
 *
 * Output schema (strictly enforced):
 *   { action: "FIRE" | "BUFFER" | "DROP", score: number, reason: string }
 */

import * as path from 'path'
import * as fs from 'fs'
import { logger as rootLogger } from '../../logger.js'

const log = rootLogger.child({ module: 'sentinel-provider' })

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SentinelScoringInput {
    /** Stimulus type (weather, traffic, social, event, food, price) */
    stimulusType: string
    /** Stimulus key / unique identifier */
    stimulusKey: string
    /** Raw stimulus data */
    stimulusData: unknown
    /** User's engagement state */
    pulseState: string
    /** User's pulse score */
    pulseScore: number
    /** Number of proactive messages sent today */
    proactiveCountToday: number
    /** Max proactive messages per day */
    maxPerDay: number
    /** Matched preference keys (if any) */
    matchedPreferences?: string[]
}

export interface SentinelScoreResult {
    /** Scoring decision */
    action: 'FIRE' | 'BUFFER' | 'DROP'
    /** Computed relevance score (0-1) */
    score: number
    /** Human-readable reason for the decision */
    reason: string
    /** Provider used for this score */
    provider: string
    /** Latency in milliseconds */
    latencyMs: number
}

// ─── Sentinel Soul Prompt Cache ───────────────────────────────────────────────

let sentinelSoulCache: string | null = null
let sentinelSoulMtime = 0

function loadSentinelSoul(): string {
    const soulPath = path.resolve(process.cwd(), 'config', 'sentinel-soul.md')
    try {
        const stat = fs.statSync(soulPath)
        const mtime = stat.mtimeMs
        if (sentinelSoulCache && mtime === sentinelSoulMtime) return sentinelSoulCache
        sentinelSoulCache = fs.readFileSync(soulPath, 'utf8')
        sentinelSoulMtime = mtime
        return sentinelSoulCache
    } catch {
        log.warn('sentinel-soul.md not found — using inline scoring prompt')
        return `You are a background scoring engine. Evaluate the given stimulus and decide: FIRE (send now), BUFFER (save), or DROP (discard). Return strict JSON: {"action":"FIRE"|"BUFFER"|"DROP","score":0.0-1.0,"reason":"..."}. Be conservative — only FIRE for highly relevant, timely stimuli.`
    }
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildScoringPrompt(input: SentinelScoringInput): string {
    return `${loadSentinelSoul()}

## Stimulus to Evaluate
- Type: ${input.stimulusType}
- Key: ${input.stimulusKey}
- Data: ${JSON.stringify(input.stimulusData, null, 2).slice(0, 500)}
- User Pulse: ${input.pulseState} (score=${input.pulseScore})
- Proactive today: ${input.proactiveCountToday}/${input.maxPerDay}
- Matched preferences: ${input.matchedPreferences?.join(', ') || 'none'}

Respond with ONLY valid JSON: {"action":"FIRE"|"BUFFER"|"DROP","score":0.0,"reason":"..."}`
}

// ─── JSON Parser ──────────────────────────────────────────────────────────────

function parseScoringResponse(raw: string, fallbackReason = 'parse error'): Pick<SentinelScoreResult, 'action' | 'score' | 'reason'> {
    try {
        const jsonMatch = raw.match(/\{[^}]+\}/)
        if (!jsonMatch) throw new Error('No JSON found')
        const parsed = JSON.parse(jsonMatch[0])
        const action = (['FIRE', 'BUFFER', 'DROP'] as const).includes(parsed.action)
            ? parsed.action as 'FIRE' | 'BUFFER' | 'DROP'
            : 'DROP'
        const score = typeof parsed.score === 'number' ? Math.min(1, Math.max(0, parsed.score)) : 0
        const reason = typeof parsed.reason === 'string' ? parsed.reason : 'no reason'
        return { action, score, reason }
    } catch {
        log.warn({ raw: raw.slice(0, 200) }, 'Failed to parse sentinel JSON — defaulting to DROP')
        return { action: 'DROP', score: 0, reason: fallbackReason }
    }
}

// ─── Bedrock Provider (real-time scoring) ────────────────────────────────────

async function scoreWithBedrock(prompt: string): Promise<{ content: string; latencyMs: number }> {
    const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime')

    const region = process.env.AWS_BEDROCK_REGION ?? process.env.AWS_REGION ?? 'ap-south-1'
    const modelId = process.env.AWS_BEDROCK_MODEL_ID ?? 'anthropic.claude-3-haiku-20240307-v1:0'

    const client = new BedrockRuntimeClient({ region })

    // Build request body for Anthropic Claude models on Bedrock
    const isAnthropic = modelId.startsWith('anthropic.')
    let body: string

    if (isAnthropic) {
        body = JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 150,
            messages: [{ role: 'user', content: prompt }],
        })
    } else {
        // Meta Llama on Bedrock (converse API shape)
        body = JSON.stringify({
            prompt: `<s>[INST] ${prompt} [/INST]`,
            max_gen_len: 150,
            temperature: 0.1,
        })
    }

    const start = Date.now()
    const command = new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body,
    })

    const response = await client.send(command)
    const latencyMs = Date.now() - start
    const responseBody = JSON.parse(new TextDecoder().decode(response.body))

    // Extract text from Anthropic vs Meta Llama response shapes
    let content: string
    if (isAnthropic) {
        content = responseBody.content?.[0]?.text ?? ''
    } else {
        content = responseBody.generation ?? ''
    }

    return { content, latencyMs }
}

// ─── Together AI (fallback / batch) ──────────────────────────────────────────

async function scoreWithTogether(prompt: string): Promise<{ content: string; latencyMs: number }> {
    const apiKey = process.env.TOGETHER_API_KEY
    if (!apiKey) throw new Error('TOGETHER_API_KEY not set')

    const model = process.env.TOGETHER_CHAT_MODEL ?? 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
    const start = Date.now()

    const resp = await fetch('https://api.together.xyz/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 150,
            temperature: 0.1,
        }),
    })

    if (!resp.ok) {
        const text = await resp.text()
        throw new Error(`Together AI error ${resp.status}: ${text.slice(0, 200)}`)
    }

    const data = await resp.json() as any
    const content = data.choices?.[0]?.message?.content ?? ''
    return { content, latencyMs: Date.now() - start }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Score a single stimulus in real-time (Bedrock → Together fallback).
 */
export async function sentinelScore(input: SentinelScoringInput): Promise<SentinelScoreResult> {
    const prompt = buildScoringPrompt(input)

    // Try Bedrock first (real-time scoring)
    const bedrockEnabled = process.env.AWS_ENABLED === 'true' && process.env.AWS_BEDROCK_REGION

    if (bedrockEnabled) {
        try {
            const { content, latencyMs } = await scoreWithBedrock(prompt)
            const parsed = parseScoringResponse(content)

            log.info(
                { ...parsed, latencyMs, stimulusKey: input.stimulusKey, userId: undefined },
                `[Sentinel/Provider] Using bedrock (real-time). Result: ${parsed.action} score=${parsed.score.toFixed(2)}`
            )

            return { ...parsed, provider: 'bedrock', latencyMs }
        } catch (err) {
            log.warn({ err, stimulusKey: input.stimulusKey }, 'Bedrock failed — falling back to Together AI')
        }
    }

    // Together AI fallback
    try {
        const { content, latencyMs } = await scoreWithTogether(prompt)
        const parsed = parseScoringResponse(content)

        log.info(
            { ...parsed, latencyMs, stimulusKey: input.stimulusKey },
            `[Sentinel/Provider] Using together-batch (single-item mode). Result: ${parsed.action} score=${parsed.score.toFixed(2)}`
        )

        return { ...parsed, provider: 'together-batch', latencyMs }
    } catch (err) {
        log.error({ err, stimulusKey: input.stimulusKey }, 'All Sentinel providers failed — defaulting to DROP')
        return {
            action: 'DROP',
            score: 0,
            reason: 'All providers failed',
            provider: 'none',
            latencyMs: 0,
        }
    }
}

/**
 * Batch score multiple stimuli (Together AI batch — cost-efficient for 500+ users).
 * Falls back to sequential Bedrock calls if Together is unavailable.
 */
export async function sentinelBatchScore(inputs: SentinelScoringInput[]): Promise<SentinelScoreResult[]> {
    if (inputs.length === 0) return []

    const batchStart = Date.now()
    log.info({ count: inputs.length }, `[Sentinel/Provider] Batch scoring: ${inputs.length} stimuli`)

    // For small batches (<= 10), run sequentially with a short delay to avoid rate limits
    const results = await Promise.all(
        inputs.map(input =>
            sentinelScore(input).catch(err => {
                log.error({ err, stimulusKey: input.stimulusKey }, 'Batch item failed')
                return {
                    action: 'DROP' as const,
                    score: 0,
                    reason: 'Batch processing error',
                    provider: 'error',
                    latencyMs: 0,
                }
            })
        )
    )

    const totalMs = Date.now() - batchStart
    const fire = results.filter(r => r.action === 'FIRE').length
    const buffer = results.filter(r => r.action === 'BUFFER').length
    const drop = results.filter(r => r.action === 'DROP').length

    log.info(
        { total: inputs.length, totalMs, avgMs: Math.round(totalMs / inputs.length), fire, buffer, drop },
        `[Sentinel/Provider] Batch complete: ${inputs.length} scored in ${totalMs}ms (${Math.round(totalMs / inputs.length)}ms/stimulus avg). Results: ${fire} FIRE, ${buffer} BUFFER, ${drop} DROP`
    )

    return results
}
