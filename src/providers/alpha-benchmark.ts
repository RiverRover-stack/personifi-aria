/**
 * Alpha Provider Benchmark (#140)
 *
 * Measures latency, throughput, and function calling accuracy across providers:
 *   Together AI → Fireworks AI → Groq (tierManager fallback)
 *
 * Run:
 *   TOGETHER_API_KEY=... FIREWORKS_API_KEY=... GROQ_API_KEY=... \
 *   npx tsx src/providers/alpha-benchmark.ts
 *
 * Optional env:
 *   BENCHMARK_ROUNDS=5        (default: 3 rounds per test)
 *   BENCHMARK_PROVIDERS=together,fireworks,groq  (default: all configured)
 */

import { TogetherProvider } from '../llm/providers/together.js'
import { FireworksProvider } from '../llm/providers/fireworks.js'
import { generateResponse } from '../llm/tierManager.js'
import type { LLMProviderWithTools } from '../llm/providers/types.js'
import { ALPHA_TOOL_DEFINITIONS } from '../tool-definitions.js'

// ─── Config ──────────────────────────────────────────────────────────────────

const ROUNDS = parseInt(process.env.BENCHMARK_ROUNDS ?? '3', 10)
const SELECTED = new Set((process.env.BENCHMARK_PROVIDERS ?? 'together,fireworks,groq').split(',').map(s => s.trim()))

// ─── Test Cases ───────────────────────────────────────────────────────────────

interface BenchCase {
    label: string
    type: 'plain_chat' | 'tool_call'
    /** Expected tool name when type === 'tool_call', or null */
    expectedTool: string | null
    systemPrompt: string
    userMessage: string
}

const CASES: BenchCase[] = [
    {
        label: 'Plain chat — short greeting',
        type: 'plain_chat',
        expectedTool: null,
        systemPrompt: 'You are Aria, a friendly assistant. Respond in 1-2 sentences.',
        userMessage: 'Hey! How are you doing today?',
    },
    {
        label: 'Tool call — cab compare',
        type: 'tool_call',
        expectedTool: 'cab_compare',
        systemPrompt: 'You are Aria. Use tools when the user needs real-time data.',
        userMessage: 'Compare cab prices from Koramangala to Bangalore Airport for me',
    },
    {
        label: 'Tool call — weather check',
        type: 'tool_call',
        expectedTool: 'weather_check',
        systemPrompt: 'You are Aria. Use tools when the user needs real-time data.',
        userMessage: "What's the weather like in Indiranagar right now?",
    },
    {
        label: 'Tool call — food finder',
        type: 'tool_call',
        expectedTool: 'food_finder',
        systemPrompt: 'You are Aria. Use tools when the user needs real-time data.',
        userMessage: 'I want to order biryani. What are my options?',
    },
    {
        label: 'Tool call — place search (ambiguous)',
        type: 'tool_call',
        expectedTool: 'place_search',
        systemPrompt: 'You are Aria. Use tools when the user needs real-time data.',
        userMessage: 'Any good coffee shops open near HSR Layout right now?',
    },
    {
        label: 'Plain chat — no tool needed',
        type: 'plain_chat',
        expectedTool: null,
        systemPrompt: 'You are Aria. Only use tools for real-time data requests.',
        userMessage: "What's the capital of France?",
    },
]

// ─── Result Types ─────────────────────────────────────────────────────────────

interface RoundResult {
    latencyMs: number
    toolCalled: string | null
    correct: boolean
    error: string | null
}

interface ProviderReport {
    providerName: string
    case: string
    rounds: RoundResult[]
    avgLatencyMs: number
    p95LatencyMs: number
    accuracy: number   // fraction of rounds where tool call matched expected
    errorRate: number
}

// ─── Benchmark Runner ─────────────────────────────────────────────────────────

async function benchmarkProvider(
    name: string,
    runner: (c: BenchCase) => Promise<{ latencyMs: number; toolCalled: string | null }>,
    cases: BenchCase[]
): Promise<ProviderReport[]> {
    const reports: ProviderReport[] = []

    for (const c of cases) {
        const rounds: RoundResult[] = []

        for (let r = 0; r < ROUNDS; r++) {
            const start = Date.now()
            try {
                const { latencyMs, toolCalled } = await runner(c)
                const correct = c.expectedTool === null
                    ? toolCalled === null
                    : toolCalled === c.expectedTool
                rounds.push({ latencyMs, toolCalled, correct, error: null })
            } catch (err) {
                rounds.push({
                    latencyMs: Date.now() - start,
                    toolCalled: null,
                    correct: false,
                    error: (err as Error).message.slice(0, 100),
                })
            }

            // Small delay to avoid rate limiting between rounds
            if (r < ROUNDS - 1) await sleep(500)
        }

        const latencies = rounds.filter(r => !r.error).map(r => r.latencyMs).sort((a, b) => a - b)
        const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0
        const p95LatencyMs = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] ?? latencies[latencies.length - 1] : 0
        const accuracy = rounds.filter(r => r.correct).length / rounds.length
        const errorRate = rounds.filter(r => r.error).length / rounds.length

        reports.push({ providerName: name, case: c.label, rounds, avgLatencyMs, p95LatencyMs, accuracy, errorRate })
    }

    return reports
}

// ─── Provider Runners ─────────────────────────────────────────────────────────

function makeToolRunner(provider: LLMProviderWithTools) {
    return async (c: BenchCase) => {
        const start = Date.now()

        if (c.type === 'tool_call') {
            const result = await provider.chatWithTools({
                messages: [{ role: 'user', content: c.userMessage }],
                systemPrompt: c.systemPrompt,
                tools: ALPHA_TOOL_DEFINITIONS,
                toolChoice: 'auto',
                maxTokens: 256,
                temperature: 0.1,
            })
            return {
                latencyMs: result.latencyMs,
                toolCalled: result.toolCalls[0]?.function.name ?? null,
            }
        } else {
            const result = await provider.chat({
                messages: [{ role: 'user', content: c.userMessage }],
                systemPrompt: c.systemPrompt,
                maxTokens: 128,
                temperature: 0.7,
            })
            return { latencyMs: result.latencyMs, toolCalled: null }
        }
    }
}

async function groqRunner(c: BenchCase) {
    const start = Date.now()
    const messages = [
        { role: 'system' as const, content: c.systemPrompt },
        { role: 'user' as const, content: c.userMessage },
    ]
    const { text } = await generateResponse(messages, {
        maxTokens: 128,
        temperature: 0.7,
    })
    return { latencyMs: Date.now() - start, toolCalled: null }
}

// ─── Report Printer ───────────────────────────────────────────────────────────

function printReport(all: ProviderReport[]): void {
    console.log('\n' + '═'.repeat(80))
    console.log('  ALPHA PROVIDER BENCHMARK RESULTS')
    console.log('═'.repeat(80))

    const byProvider = new Map<string, ProviderReport[]>()
    for (const r of all) {
        const list = byProvider.get(r.providerName) ?? []
        list.push(r)
        byProvider.set(r.providerName, list)
    }

    for (const [providerName, reports] of byProvider) {
        console.log(`\n▶ ${providerName.toUpperCase()}`)
        console.log('─'.repeat(60))

        let totalAccuracy = 0
        let totalAvgLatency = 0
        let totalErrors = 0

        for (const r of reports) {
            const toolAccuracy = CASES.find(c => c.label === r.case)?.expectedTool !== null
                ? ` accuracy=${(r.accuracy * 100).toFixed(0)}%`
                : ''
            console.log(
                `  ${r.case.padEnd(45)} avg=${r.avgLatencyMs}ms  p95=${r.p95LatencyMs}ms${toolAccuracy}${r.errorRate > 0 ? `  errors=${(r.errorRate * 100).toFixed(0)}%` : ''}`
            )
            totalAccuracy += r.accuracy
            totalAvgLatency += r.avgLatencyMs
            totalErrors += r.errorRate
        }

        const n = reports.length
        console.log('─'.repeat(60))
        console.log(`  TOTALS  avg_latency=${Math.round(totalAvgLatency / n)}ms  avg_accuracy=${(totalAccuracy / n * 100).toFixed(0)}%  avg_errors=${(totalErrors / n * 100).toFixed(0)}%`)
    }

    // Side-by-side comparison for tool_call cases
    const toolCases = CASES.filter(c => c.type === 'tool_call').map(c => c.label)
    if (toolCases.length > 0 && all.length > 0) {
        console.log('\n' + '─'.repeat(80))
        console.log('  FUNCTION CALLING ACCURACY COMPARISON')
        console.log('─'.repeat(80))
        const providers = [...new Set(all.map(r => r.providerName))]
        const header = 'Test Case'.padEnd(47) + providers.map(p => p.padEnd(14)).join('')
        console.log(header)
        for (const label of toolCases) {
            const row = label.padEnd(47) + providers.map(p => {
                const report = all.find(r => r.providerName === p && r.case === label)
                if (!report) return 'N/A'.padEnd(14)
                return `${(report.accuracy * 100).toFixed(0)}% (${report.avgLatencyMs}ms)`.padEnd(14)
            }).join('')
            console.log(row)
        }
    }

    console.log('\n' + '═'.repeat(80) + '\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\nAlpha Provider Benchmark — ${ROUNDS} rounds per case`)
    console.log(`Providers: ${[...SELECTED].join(', ')}`)
    console.log(`Cases: ${CASES.length} (${CASES.filter(c => c.type === 'tool_call').length} tool calls, ${CASES.filter(c => c.type === 'plain_chat').length} plain chat)\n`)

    const allReports: ProviderReport[] = []
    const together = new TogetherProvider()
    const fireworks = new FireworksProvider()

    if (SELECTED.has('together') && await together.isAvailable()) {
        console.log('Benchmarking Together AI...')
        const reports = await benchmarkProvider('together', makeToolRunner(together), CASES)
        allReports.push(...reports)
    } else if (SELECTED.has('together')) {
        console.warn('⚠️  Together AI: TOGETHER_API_KEY not set — skipping')
    }

    if (SELECTED.has('fireworks') && await fireworks.isAvailable()) {
        console.log('Benchmarking Fireworks AI...')
        const reports = await benchmarkProvider('fireworks', makeToolRunner(fireworks), CASES)
        allReports.push(...reports)
    } else if (SELECTED.has('fireworks')) {
        console.warn('⚠️  Fireworks AI: FIREWORKS_API_KEY not set — skipping')
    }

    if (SELECTED.has('groq') && process.env.GROQ_API_KEY) {
        console.log('Benchmarking Groq (plain chat only — no function calling in tierManager)...')
        // Groq via tierManager doesn't support function calling, only plain chat cases
        const groqCases = CASES.filter(c => c.type === 'plain_chat')
        const reports = await benchmarkProvider('groq', groqRunner, groqCases)
        allReports.push(...reports)
    } else if (SELECTED.has('groq')) {
        console.warn('⚠️  Groq: GROQ_API_KEY not set — skipping')
    }

    if (allReports.length === 0) {
        console.error('No providers were benchmarked. Set at least one API key.')
        process.exit(1)
    }

    printReport(allReports)
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

main().catch(err => { console.error('Benchmark failed:', err); process.exit(1) })
