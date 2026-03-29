import {
  CLASSIFIER_SIGNAL_WEIGHTS,
  DESIRE_PATTERNS,
  FAST_REPLY_WINDOW_SECONDS,
  REJECTION_PATTERNS,
  SIGNAL_WEIGHTS,
  TOPIC_MATCH_THRESHOLD,
  URGENCY_PATTERNS,
} from './constants.js'
import type { EngagementSignals, PulseInput } from './types.js'
import type { BedrockSignals } from '../intelligence/bedrock-extractor.js'

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'can', 'do', 'for', 'from', 'get', 'go',
  'i', 'if', 'in', 'is', 'it', 'its', 'let', 'me', 'my', 'of', 'on', 'or',
  'please', 'show', 'that', 'the', 'this', 'to', 'we', 'with', 'you', 'your',
])

// ─── New signal patterns ──────────────────────────────────────────────────────

const POSITIVE_PATTERNS: RegExp[] = [
  /\b(thanks|thank you|thx|ty)\b/i,
  /\b(great|awesome|perfect|nice|love it|that's good|good one)\b/i,
  /\b(yes|yeah|yep|sure|okay|ok|sounds good|let's go|let's do it)\b/i,
]

const TOOL_COMMITMENT_PATTERNS: RegExp[] = [
  /\b(book|order|buy|get|reserve|confirm|go ahead|do it|yes book|yes order)\b/i,
  /\b(compare|check|find|show|search)\b.*\b(now|please|for me)\b/i,
]

const SLOW_REPLY_THRESHOLD_SECONDS = 600 // 10 minutes

function hasAnyPattern(message: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(message))
}

function parseTimestamp(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function isFastReply(previousMessageAt: Date | null, now: Date): boolean {
  if (!previousMessageAt) return false
  const deltaSeconds = (now.getTime() - previousMessageAt.getTime()) / 1000
  return deltaSeconds > 0 && deltaSeconds <= FAST_REPLY_WINDOW_SECONDS
}

function tokenizeForTopic(message: string): string[] {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(word => !STOP_WORDS.has(word))

  return Array.from(new Set(words))
}

function topicOverlap(current: string[], previous: string[]): number {
  if (current.length === 0 || previous.length === 0) return 0
  const previousSet = new Set(previous)
  return current.reduce((count, token) => count + (previousSet.has(token) ? 1 : 0), 0)
}

function topicKeyFromTokens(tokens: string[]): string | null {
  if (tokens.length === 0) return null
  return tokens.slice(0, 4).join(':')
}

export function extractEngagementSignals(input: PulseInput, bedrockSignals?: BedrockSignals | null): EngagementSignals {
  const now = input.now ?? new Date()
  const normalizedMessage = input.message.trim()

  // Heuristic regex-based signals
  let urgency = hasAnyPattern(normalizedMessage, URGENCY_PATTERNS) ? SIGNAL_WEIGHTS.urgency : 0
  let desire = hasAnyPattern(normalizedMessage, DESIRE_PATTERNS) ? SIGNAL_WEIGHTS.desire : 0
  let rejection = hasAnyPattern(normalizedMessage, REJECTION_PATTERNS) ? SIGNAL_WEIGHTS.rejection : 0

  // Blend Bedrock signals when available (weighted average: 60% Bedrock, 40% heuristic)
  if (bedrockSignals) {
    const bedrockUrgency = bedrockSignals.urgency * SIGNAL_WEIGHTS.urgency
    urgency = urgency > 0
      ? urgency * 0.4 + bedrockUrgency * 0.6
      : bedrockUrgency

    if (bedrockSignals.desire && desire === 0) {
      desire = SIGNAL_WEIGHTS.desire * 0.6
    }

    if (bedrockSignals.rejection && rejection === 0) {
      rejection = SIGNAL_WEIGHTS.rejection * 0.6
    }
  }

  const previousMessageAt = parseTimestamp(input.previousMessageAt)
  const fastReply = isFastReply(previousMessageAt, now) ? SIGNAL_WEIGHTS.fastReply : 0

  const currentTokens = tokenizeForTopic(normalizedMessage)
  const previousTokens = tokenizeForTopic(input.previousUserMessage ?? '')
  const overlap = topicOverlap(currentTokens, previousTokens)
  const topicPersistence = overlap >= TOPIC_MATCH_THRESHOLD ? SIGNAL_WEIGHTS.topicPersistence : 0

  // ── New signals ───────────────────────────────────────────────────────────
  // positive: user responds warmly to a proactive message or general reply
  const positive = hasAnyPattern(normalizedMessage, POSITIVE_PATTERNS) ? SIGNAL_WEIGHTS.positive : 0

  // toolCommitment: user explicitly commits to a tool action
  const toolCommitment = hasAnyPattern(normalizedMessage, TOOL_COMMITMENT_PATTERNS) ? SIGNAL_WEIGHTS.toolCommitment : 0

  // slowReply: user took > 10 min to reply (signals disengagement)
  let slowReply = 0
  if (previousMessageAt) {
    const deltaSeconds = (now.getTime() - previousMessageAt.getTime()) / 1000
    if (deltaSeconds > SLOW_REPLY_THRESHOLD_SECONDS) {
      slowReply = SIGNAL_WEIGHTS.slowReply
    }
  }

  // ignoredProactive: caller sets classifierSignal = 'ignored_proactive' when
  // Sentinel detects no reply to a FIRE within the cooldown window
  const ignoredProactive = input.classifierSignal === 'ignored_proactive'
    ? SIGNAL_WEIGHTS.ignoredProactive
    : 0

  const classifierSignalKey = input.classifierSignal ?? 'normal'
  const classifierSignal = (classifierSignalKey !== 'ignored_proactive' && Object.prototype.hasOwnProperty.call(
    CLASSIFIER_SIGNAL_WEIGHTS,
    classifierSignalKey,
  ))
    ? CLASSIFIER_SIGNAL_WEIGHTS[classifierSignalKey as keyof typeof CLASSIFIER_SIGNAL_WEIGHTS]
    : CLASSIFIER_SIGNAL_WEIGHTS.normal

  const scoreDelta =
    urgency + desire + rejection + fastReply + topicPersistence +
    positive + toolCommitment + slowReply + ignoredProactive + classifierSignal

  const matchedSignals: string[] = []
  if (urgency !== 0) matchedSignals.push('urgency')
  if (desire !== 0) matchedSignals.push('desire')
  if (rejection !== 0) matchedSignals.push('rejection')
  if (fastReply !== 0) matchedSignals.push('fast_reply')
  if (topicPersistence !== 0) matchedSignals.push('topic_persistence')
  if (positive !== 0) matchedSignals.push('positive')
  if (toolCommitment !== 0) matchedSignals.push('tool_commitment')
  if (slowReply !== 0) matchedSignals.push('slow_reply')
  if (ignoredProactive !== 0) matchedSignals.push('ignored_proactive')
  if (classifierSignal !== 0) matchedSignals.push(`classifier_${classifierSignalKey}`)
  if (bedrockSignals) matchedSignals.push('bedrock_enhanced')

  return {
    scoreDelta,
    matchedSignals,
    topicKey: topicKeyFromTokens(currentTokens),
    breakdown: {
      urgency,
      desire,
      rejection,
      fastReply,
      topicPersistence,
      classifierSignal,
    },
  }
}
