/**
 * Message Queue — Per-User Concurrency Control (Issue #139)
 *
 * Guarantees:
 *   Same user   → sequential processing (no races, correct ordering)
 *   Diff users  → parallel processing  (max throughput)
 *
 * Features:
 *   1. Per-user Promise chain — each message awaits the previous one for that user
 *   2. Queue depth cap — reject if > MAX_QUEUE_DEPTH_PER_USER pending
 *   3. Provider rate limiting — token bucket per LLM provider
 *   4. No external dependencies — in-memory Map, works on a single instance
 *
 * Environment variables:
 *   MAX_CONCURRENT_USERS=50      (informational; in-memory map scales naturally)
 *   MAX_QUEUE_DEPTH_PER_USER=5
 */

import { logger as rootLogger } from '../logger.js'

const log = rootLogger.child({ module: 'concurrency/queue' })

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_QUEUE_DEPTH = parseInt(process.env.MAX_QUEUE_DEPTH_PER_USER ?? '5', 10)

// ─── Per-User Queue State ─────────────────────────────────────────────────────

interface UserQueueEntry {
    /** Pending tail of the promise chain for this user */
    tail: Promise<void>
    /** How many messages are currently queued (including in-flight) */
    depth: number
}

const userQueues = new Map<string, UserQueueEntry>()

// ─── Rate Limiter (token bucket per provider) ─────────────────────────────────

interface TokenBucket {
    /** Capacity of the bucket (max tokens = max RPM) */
    capacity: number
    /** Current token count */
    tokens: number
    /** Timestamp of last refill (ms) */
    lastRefill: number
    /** Tokens added per millisecond */
    ratePerMs: number
}

const providerBuckets = new Map<string, TokenBucket>()

const PROVIDER_RPMS: Record<string, number> = {
    together: 600,
    fireworks: 300,
    groq: 30,
    bedrock: 100,
}

function getBucket(provider: string): TokenBucket {
    if (!providerBuckets.has(provider)) {
        const rpm = PROVIDER_RPMS[provider] ?? 60
        providerBuckets.set(provider, {
            capacity: rpm,
            tokens: rpm,
            lastRefill: Date.now(),
            ratePerMs: rpm / 60_000,
        })
    }
    return providerBuckets.get(provider)!
}

function refillBucket(bucket: TokenBucket): void {
    const now = Date.now()
    const elapsed = now - bucket.lastRefill
    const replenished = elapsed * bucket.ratePerMs
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + replenished)
    bucket.lastRefill = now
}

/**
 * Try to consume one token for a provider.
 * Returns true if the request can proceed immediately.
 */
export function tryConsumeProviderSlot(provider: string): boolean {
    const bucket = getBucket(provider)
    refillBucket(bucket)

    if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        if (bucket.tokens / bucket.capacity < 0.05) {
            log.warn(
                { provider, remaining: Math.floor(bucket.tokens), capacity: bucket.capacity },
                `[RateLimit] ${provider}: ${Math.floor(bucket.tokens)}/${bucket.capacity} RPM — approaching limit`
            )
        }
        return true
    }

    log.warn({ provider, capacity: bucket.capacity }, `[RateLimit] ${provider}: ${bucket.capacity}/${bucket.capacity} RPM — throttling (queuing requests)`)
    return false
}

/**
 * Wait until a provider slot is available (at most ~2 seconds).
 */
export async function waitForProviderSlot(provider: string, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const bucket = getBucket(provider)

    while (Date.now() < deadline) {
        refillBucket(bucket)
        if (bucket.tokens >= 1) {
            bucket.tokens -= 1
            log.debug({ provider }, `[RateLimit] ${provider}: bucket refilled, resuming`)
            return
        }
        // Wait for ~1 token's worth of time then retry
        const waitMs = Math.min(Math.ceil(1 / bucket.ratePerMs), 200)
        await new Promise(r => setTimeout(r, waitMs))
    }

    log.warn({ provider, timeoutMs }, `[RateLimit] ${provider}: slot wait timed out — proceeding anyway`)
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue a message handler for a user.
 * - Same user messages are sequenced: each one awaits the previous.
 * - Different user messages run in parallel.
 * - If queue depth exceeds MAX_QUEUE_DEPTH, returns an overflow result.
 *
 * @param userId   User identifier (for per-user sequencing)
 * @param msgIndex Monotonic message index (for log traceability)
 * @param fn       The async task to execute (e.g. handleMessage call)
 * @returns        Result of fn, or an overflow sentinel
 */
export async function enqueueForUser<T>(
    userId: string,
    msgIndex: number,
    fn: () => Promise<T>,
): Promise<T | { __overflow: true }> {
    // Get or create queue entry
    let entry = userQueues.get(userId)

    if (!entry) {
        entry = { tail: Promise.resolve(), depth: 0 }
        userQueues.set(userId, entry)
    }

    // Check queue depth
    if (entry.depth >= MAX_QUEUE_DEPTH) {
        log.warn(
            { userId, depth: entry.depth, max: MAX_QUEUE_DEPTH },
            `[Queue] user=${userId} enqueue msg#${msgIndex} — REJECTED (queue depth ${entry.depth} exceeded)`
        )
        return { __overflow: true }
    }

    entry.depth++
    log.info({ userId, depth: entry.depth }, `[Queue] user=${userId} enqueue msg#${msgIndex} (queue depth: ${entry.depth})`)

    // Chain onto the user's tail
    let resolveStep!: () => void
    const stepDone = new Promise<void>(r => { resolveStep = r })

    const prevTail = entry.tail
    entry.tail = stepDone

    // Execute when our turn comes
    let result: T
    try {
        await prevTail // wait for any in-flight message to complete
        log.info({ userId }, `[Queue] user=${userId} processing msg#${msgIndex}`)

        const start = Date.now()
        result = await fn()
        const elapsed = Date.now() - start

        log.info({ userId, elapsed }, `[Queue] user=${userId} msg#${msgIndex} complete (${elapsed}ms)`)
    } finally {
        entry.depth = Math.max(0, entry.depth - 1)
        resolveStep()

        // Clean up idle entries to prevent memory leak
        if (entry.depth === 0) {
            // Give a brief grace period before removing (next message may arrive immediately)
            setTimeout(() => {
                const current = userQueues.get(userId)
                if (current && current.depth === 0) {
                    userQueues.delete(userId)
                }
            }, 5_000)
        }
    }

    return result!
}

/**
 * Return true if the result was a queue overflow (caller should send overflow message).
 */
export function isQueueOverflow<T>(result: T | { __overflow: true }): result is { __overflow: true } {
    return typeof result === 'object' && result !== null && '__overflow' in result
}

/**
 * Current queue depth for a user (0 = idle).
 */
export function getUserQueueDepth(userId: string): number {
    return userQueues.get(userId)?.depth ?? 0
}

/**
 * Number of users with active queues (diagnostic).
 */
export function getActiveUserCount(): number {
    return userQueues.size
}
