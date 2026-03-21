/**
 * Together AI Batch Client — async bulk scoring for Sentinel Phase 1.
 *
 * NOT an LLMProvider — batch jobs are fundamentally different from chat.
 * Uses Together's Batch API (OpenAI-compatible) for 50% cost reduction.
 *
 * Flow: buildBatchFile() → submitScoringBatch() → pollBatchResults() → parseBatchResults()
 *
 * Custom ID format: `{userId}__{stimulusId}` — maps results back to scoring matrix.
 * Batch pricing: $0.44/M tokens (vs $0.88/M real-time)
 */

import type { Message, TokenUsage } from '../provider.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.together.xyz/v1'
const DEFAULT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
const POLL_INTERVAL_MS = 15_000
const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000   // 5 minutes
const TIMEOUT_MS = 30_000

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScoringRequest {
    userId: string
    stimulusId: string
    messages: Message[]
    model?: string
    maxTokens?: number
    temperature?: number
}

export interface ScoringResult {
    userId: string
    stimulusId: string
    score: number
    reasoning: string
    usage: TokenUsage
}

export interface BatchStatus {
    id: string
    status: 'validating' | 'in_progress' | 'completed' | 'failed' | 'expired' | 'cancelled'
    outputFileId: string | null
    totalRequests: number
    completedRequests: number
    failedRequests: number
}

export interface BatchCycleResult {
    results: ScoringResult[]
    totalUsage: TokenUsage
    batchId: string
    durationMs: number
    failedCount: number
}

// ─── Batch Client ───────────────────────────────────────────────────────────

/**
 * Build a JSONL batch file from scoring requests.
 * Each line is an OpenAI-compatible batch request with custom_id = `userId__stimulusId`.
 */
export function buildBatchFile(requests: ScoringRequest[]): string {
    const lines: string[] = []

    for (const req of requests) {
        const line = {
            custom_id: `${req.userId}__${req.stimulusId}`,
            method: 'POST',
            url: '/v1/chat/completions',
            body: {
                model: req.model || DEFAULT_MODEL,
                messages: req.messages.map(m => ({
                    role: m.role,
                    content: m.content,
                })),
                max_tokens: req.maxTokens ?? 50,
                temperature: req.temperature ?? 0.1,
                response_format: { type: 'json_object' },
            },
        }
        lines.push(JSON.stringify(line))
    }

    return lines.join('\n')
}

/**
 * Upload JSONL file and submit a batch job.
 * Returns the batch ID for polling.
 */
export async function submitScoringBatch(jsonlContent: string): Promise<string> {
    const apiKey = process.env.TOGETHER_API_KEY
    if (!apiKey) throw new Error('[Together/Batch] TOGETHER_API_KEY not set')

    // Step 1: Upload the JSONL file
    const fileBlob = new Blob([jsonlContent], { type: 'application/jsonl' })
    const formData = new FormData()
    formData.append('file', fileBlob, 'sentinel-scoring.jsonl')
    formData.append('purpose', 'batch')

    const uploadResp = await fetch(`${BASE_URL}/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!uploadResp.ok) {
        const err = await uploadResp.text().catch(() => '')
        throw new Error(`[Together/Batch] File upload failed (${uploadResp.status}): ${err}`)
    }

    const uploadData = await uploadResp.json() as { id: string }
    const inputFileId = uploadData.id
    console.log(`[Together/Batch] File uploaded: ${inputFileId}`)

    // Step 2: Create the batch
    const batchResp = await fetch(`${BASE_URL}/batches`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            input_file_id: inputFileId,
            endpoint: '/v1/chat/completions',
            completion_window: '24h',
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!batchResp.ok) {
        const err = await batchResp.text().catch(() => '')
        throw new Error(`[Together/Batch] Batch creation failed (${batchResp.status}): ${err}`)
    }

    const batchData = await batchResp.json() as { id: string }
    console.log(`[Together/Batch] Batch created: ${batchData.id}`)

    return batchData.id
}

/**
 * Poll batch status until completed or timeout.
 * Returns the output file ID for downloading results.
 */
export async function pollBatchResults(
    batchId: string,
    maxWaitMs: number = DEFAULT_MAX_WAIT_MS,
): Promise<BatchStatus> {
    const apiKey = process.env.TOGETHER_API_KEY
    if (!apiKey) throw new Error('[Together/Batch] TOGETHER_API_KEY not set')

    const deadline = Date.now() + maxWaitMs
    let lastStatus: BatchStatus | null = null

    while (Date.now() < deadline) {
        const resp = await fetch(`${BASE_URL}/batches/${batchId}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        })

        if (!resp.ok) {
            const err = await resp.text().catch(() => '')
            throw new Error(`[Together/Batch] Status check failed (${resp.status}): ${err}`)
        }

        const data = await resp.json() as Record<string, unknown>
        lastStatus = {
            id: batchId,
            status: data.status as BatchStatus['status'],
            outputFileId: (data.output_file_id as string) || null,
            totalRequests: (data.request_counts as Record<string, number>)?.total || 0,
            completedRequests: (data.request_counts as Record<string, number>)?.completed || 0,
            failedRequests: (data.request_counts as Record<string, number>)?.failed || 0,
        }

        console.log(`[Together/Batch] ${batchId} — ${lastStatus.status} (${lastStatus.completedRequests}/${lastStatus.totalRequests})`)

        if (lastStatus.status === 'completed') return lastStatus
        if (lastStatus.status === 'failed' || lastStatus.status === 'expired' || lastStatus.status === 'cancelled') {
            throw new Error(`[Together/Batch] Batch ${batchId} terminal state: ${lastStatus.status}`)
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }

    throw new Error(`[Together/Batch] Batch ${batchId} timed out after ${maxWaitMs}ms — last status: ${lastStatus?.status ?? 'unknown'}`)
}

/**
 * Download and parse batch output file into scoring results.
 * Handles partial failures gracefully — failed individual requests are logged and skipped.
 */
export async function downloadBatchResults(outputFileId: string): Promise<ScoringResult[]> {
    const apiKey = process.env.TOGETHER_API_KEY
    if (!apiKey) throw new Error('[Together/Batch] TOGETHER_API_KEY not set')

    const resp = await fetch(`${BASE_URL}/files/${outputFileId}/content`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!resp.ok) {
        const err = await resp.text().catch(() => '')
        throw new Error(`[Together/Batch] Download failed (${resp.status}): ${err}`)
    }

    const text = await resp.text()
    return parseBatchOutput(text)
}

/**
 * Parse JSONL batch output into ScoringResult[].
 * Each line: { custom_id, response: { body: { choices, usage } }, error? }
 */
export function parseBatchOutput(jsonlText: string): ScoringResult[] {
    const results: ScoringResult[] = []
    const lines = jsonlText.trim().split('\n')

    for (const line of lines) {
        if (!line.trim()) continue

        try {
            const entry = JSON.parse(line) as {
                custom_id: string
                response?: {
                    status_code: number
                    body: {
                        choices: Array<{ message: { content: string } }>
                        usage?: { prompt_tokens: number; completion_tokens: number }
                    }
                }
                error?: { message: string }
            }

            if (entry.error) {
                console.warn(`[Together/Batch] Request ${entry.custom_id} failed: ${entry.error.message}`)
                continue
            }

            if (!entry.response || entry.response.status_code !== 200) {
                console.warn(`[Together/Batch] Request ${entry.custom_id} non-200: ${entry.response?.status_code}`)
                continue
            }

            // Parse custom_id back to userId + stimulusId
            // Format: `{userId}__{stimulusId}` — userId itself may contain underscores,
            // so we split on the FIRST occurrence of `__` only.
            const CUSTOM_ID_RE = /^(.+?)__(.+)$/
            const idMatch = CUSTOM_ID_RE.exec(entry.custom_id)
            if (!idMatch) {
                console.warn(`[Together/Batch] Malformed custom_id: ${entry.custom_id}`)
                continue
            }
            const [, userId, stimulusId] = idMatch

            // Parse model output — expected JSON: { score: number, reasoning: string }
            const content = entry.response.body.choices[0]?.message?.content || ''
            const parsed = safeParseScore(content)

            results.push({
                userId,
                stimulusId,
                score: parsed.score,
                reasoning: parsed.reasoning,
                usage: {
                    inputTokens: entry.response.body.usage?.prompt_tokens || 0,
                    outputTokens: entry.response.body.usage?.completion_tokens || 0,
                },
            })
        } catch (err) {
            console.warn(`[Together/Batch] Failed to parse line: ${(err as Error).message}`)
        }
    }

    return results
}

/**
 * Run a complete batch scoring cycle: build → submit → poll → download → parse.
 * Returns all results + aggregate usage for cost tracking.
 */
export async function runScoringBatch(
    requests: ScoringRequest[],
    maxWaitMs?: number,
): Promise<BatchCycleResult> {
    const start = Date.now()

    const jsonl = buildBatchFile(requests)
    console.log(`[Together/Batch] Submitting ${requests.length} scoring requests`)

    const batchId = await submitScoringBatch(jsonl)
    const status = await pollBatchResults(batchId, maxWaitMs)

    if (!status.outputFileId) {
        throw new Error(`[Together/Batch] Batch ${batchId} completed but no output file`)
    }

    const results = await downloadBatchResults(status.outputFileId)

    const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
    for (const r of results) {
        totalUsage.inputTokens += r.usage.inputTokens
        totalUsage.outputTokens += r.usage.outputTokens
    }

    const durationMs = Date.now() - start
    console.log(`[Together/Batch] Cycle complete — ${results.length}/${requests.length} scored, ${status.failedRequests} failed, ${durationMs}ms`)

    return {
        results,
        totalUsage,
        batchId,
        durationMs,
        failedCount: status.failedRequests,
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeParseScore(content: string): { score: number; reasoning: string } {
    try {
        const parsed = JSON.parse(content) as { score?: unknown; reasoning?: unknown }
        const score = typeof parsed.score === 'number' ? parsed.score
            : typeof parsed.score === 'string' ? parseFloat(parsed.score)
            : 0

        return {
            score: Math.max(0, Math.min(1, isNaN(score) ? 0 : score)),
            reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
        }
    } catch {
        console.warn(`[Together/Batch] Failed to parse score JSON: ${content.slice(0, 100)}`)
        return { score: 0, reasoning: 'parse_error' }
    }
}
