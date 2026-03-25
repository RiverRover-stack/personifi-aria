/**
 * OCR menu and event parser — Phase 5, Issue #135
 *
 * Two-step pipeline:
 *  1. OCR step  — extract raw text from image (Groq vision / Google Cloud Vision)
 *  2. Parse step — call Groq 8B to extract structured JSON from raw text
 */

import Groq from 'groq-sdk'
import { logger as rootLogger } from '../logger.js'
import type { MenuItem, LocalEventData, OCRResult } from './types.js'

const log = rootLogger.child({ module: 'ocr' })

const GROQ_VISION_MODEL = 'llama-3.2-11b-vision-preview'
const GROQ_PARSE_MODEL = 'llama3-8b-8192'

function getGroqClient(): Groq {
    return new Groq({ apiKey: process.env.GROQ_API_KEY })
}

// ─── OCR Step ────────────────────────────────────────────────────────────────

async function extractTextViaGroqVision(imageBuffer: Buffer): Promise<string> {
    const groq = getGroqClient()
    const base64 = imageBuffer.toString('base64')
    const mimeType = detectMimeType(imageBuffer)

    const response = await groq.chat.completions.create({
        model: GROQ_VISION_MODEL,
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: { url: `data:${mimeType};base64,${base64}` },
                    },
                    {
                        type: 'text',
                        text: 'Extract all text from this image. Return only the raw text, no commentary.',
                    },
                ],
            },
        ],
        max_tokens: 1024,
    })

    return response.choices[0]?.message?.content ?? ''
}

async function extractTextViaGoogleVision(imageBuffer: Buffer): Promise<string> {
    const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY
    if (!apiKey) throw new Error('GOOGLE_CLOUD_VISION_API_KEY not set')

    const base64 = imageBuffer.toString('base64')
    const body = {
        requests: [
            {
                image: { content: base64 },
                features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
            },
        ],
    }

    const res = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    )

    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        const sanitized = text.replace(/key=[^\s&"]+/g, 'key=[redacted]')
        throw new Error(`Google Vision API error: ${sanitized}`)
    }

    const data = await res.json() as {
        responses: Array<{ fullTextAnnotation?: { text: string } }>
    }
    return data.responses[0]?.fullTextAnnotation?.text ?? ''
}

async function extractRawText(imageBuffer: Buffer): Promise<string> {
    if (process.env.OCR_PROVIDER === 'cloud') {
        return extractTextViaGoogleVision(imageBuffer)
    }
    return extractTextViaGroqVision(imageBuffer)
}

// ─── Parse Step ──────────────────────────────────────────────────────────────

async function parseStructured<T>(rawText: string, prompt: string): Promise<T | null> {
    const groq = getGroqClient()

    const response = await groq.chat.completions.create({
        model: GROQ_PARSE_MODEL,
        messages: [
            {
                role: 'system',
                content: 'You are a structured data extractor. Respond with valid JSON only, no markdown or explanation.',
            },
            {
                role: 'user',
                content: `${prompt}\n\nText:\n${rawText}`,
            },
        ],
        max_tokens: 1024,
        temperature: 0,
    })

    const content = response.choices[0]?.message?.content ?? ''
    const jsonMatch = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
    if (!jsonMatch) return null
    return JSON.parse(jsonMatch[0]) as T
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function parseMenuPhoto(imageBuffer: Buffer): Promise<OCRResult<MenuItem[]>> {
    let raw_text = ''
    try {
        raw_text = await extractRawText(imageBuffer)

        const prompt = `Extract all menu items from the text below as a JSON array.
Each item must match: { "name": string, "price": number | null, "veg": boolean, "category": string }
If price is not visible, use null. Set veg=true for vegetarian items. Return ONLY the JSON array.`

        const data = await parseStructured<MenuItem[]>(raw_text, prompt)
        if (!data || !Array.isArray(data)) {
            return { success: false, data: null, raw_text, error: 'Could not parse menu items from image' }
        }
        return { success: true, data, raw_text }
    } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        const msg = err.message.replace(/Bearer\s+[^\s"]+/gi, 'Bearer [redacted]')
        log.warn({ err: msg }, 'parseMenuPhoto failed')
        return { success: false, data: null, raw_text, error: msg }
    }
}

export async function parseEventPhoto(imageBuffer: Buffer): Promise<OCRResult<LocalEventData>> {
    let raw_text = ''
    try {
        raw_text = await extractRawText(imageBuffer)

        const prompt = `Extract event details from the text below as a JSON object.
Match this shape exactly: { "event_name": string, "venue": string, "event_date": string | null, "description": string, "tags": string[] }
For event_date use ISO 8601 format (YYYY-MM-DDTHH:mm:ss) or null if unknown.
Tags should be relevant categories like "music", "food", "sports", "tech", "art". Return ONLY the JSON object.`

        const data = await parseStructured<LocalEventData>(raw_text, prompt)
        if (!data || typeof data !== 'object' || !data.event_name) {
            return { success: false, data: null, raw_text, error: 'Could not parse event details from image' }
        }
        return { success: true, data, raw_text }
    } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        const msg = err.message.replace(/Bearer\s+[^\s"]+/gi, 'Bearer [redacted]')
        log.warn({ err: msg }, 'parseEventPhoto failed')
        return { success: false, data: null, raw_text, error: msg }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectMimeType(buf: Buffer): string {
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
    if (buf[0] === 0x52 && buf[4] === 0x57) return 'image/webp'
    return 'image/jpeg' // fallback
}
