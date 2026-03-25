/**
 * OCR Upload Endpoints — Phase 5, Issue #135
 *
 * Registers:
 *   POST /admin/upload/menu   — accepts JSON { image_base64, hostel_name, meal_type, menu_date }
 *   POST /admin/upload/event  — accepts JSON { image_base64, event_name, venue, event_date, description, tags }
 *
 * Auth: caller must send X-Telegram-Init-Data header (HMAC-SHA256 signed by Telegram).
 * The validated Telegram user ID is resolved to an internal UUID via getOrCreateUser().
 * User must have role='mess_admin' OR (for menu upload) hostel_name match.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getPool, getOrCreateUser } from '../character/session-store.js'
import { validateInitData } from '../telegram/webapp-validation.js'
import { parseMenuPhoto, parseEventPhoto } from './index.js'
import { logger as rootLogger } from '../logger.js'

const log = rootLogger.child({ module: 'ocr-upload' })

// ─── Types ────────────────────────────────────────────────────────────────────

interface MenuUploadBody {
    image_base64: string
    hostel_name: string
    meal_type: 'breakfast' | 'lunch' | 'snack' | 'dinner'
    menu_date: string  // YYYY-MM-DD
}

interface EventUploadBody {
    image_base64: string
    event_name: string
    venue?: string
    event_date?: string  // ISO 8601
    description?: string
    tags?: string | string[]  // comma-separated string OR array
}

// ─── Auth helper ─────────────────────────────────────────────────────────────

/**
 * Validates the Telegram initData from the X-Telegram-Init-Data request header.
 * Returns the internal user UUID on success, or sends 401/403 and returns null.
 */
async function resolveAdminUser(
    request: FastifyRequest,
    reply: FastifyReply,
    hostelName: string | null,
): Promise<{ userId: string; role: string | null; hostel_name: string | null } | null> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    if (!botToken) {
        log.error('TELEGRAM_BOT_TOKEN not configured — OCR upload auth unavailable')
        reply.code(503).send({ success: false, error: 'Auth service unavailable' })
        return null
    }

    const initDataStr = request.headers['x-telegram-init-data'] as string | undefined
    if (!initDataStr) {
        reply.code(401).send({ success: false, error: 'Missing X-Telegram-Init-Data header' })
        return null
    }

    const { valid, data } = validateInitData(initDataStr, botToken)
    if (!valid || !data?.user?.id) {
        reply.code(401).send({ success: false, error: 'Invalid Telegram auth token' })
        return null
    }

    const telegramUserId = String(data.user.id)
    const internalUser = await getOrCreateUser('telegram', telegramUserId)

    // Fetch role and hostel_name from users table (added in migration 010)
    const pool = getPool()
    const { rows } = await pool.query<{ role: string | null; hostel_name: string | null }>(
        `SELECT role, hostel_name FROM users WHERE user_id = $1 LIMIT 1`,
        [internalUser.userId]
    )
    const dbUser = rows[0] ?? { role: null, hostel_name: null }

    const isAdmin = dbUser.role === 'mess_admin'
    const hostelMatch = hostelName !== null && dbUser.hostel_name === hostelName

    if (!isAdmin && !hostelMatch) {
        reply.code(403).send({ success: false, error: 'Forbidden: mess_admin role or matching hostel required' })
        return null
    }

    return { userId: internalUser.userId, ...dbUser }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export async function registerOcrRoutes(fastify: FastifyInstance): Promise<void> {

    // POST /admin/upload/menu
    fastify.post<{ Body: MenuUploadBody }>('/admin/upload/menu', async (request, reply) => {
        const { image_base64, hostel_name, meal_type, menu_date } = request.body ?? {} as MenuUploadBody

        if (!image_base64 || !hostel_name || !meal_type || !menu_date) {
            return reply.code(400).send({ success: false, error: 'Missing required fields: image_base64, hostel_name, meal_type, menu_date' })
        }

        const user = await resolveAdminUser(request, reply, hostel_name)
        if (!user) return

        const imageBuffer = Buffer.from(image_base64, 'base64')
        const result = await parseMenuPhoto(imageBuffer)

        if (!result.success) {
            log.warn({ hostel_name, meal_type }, 'Menu OCR failed')
            return reply.code(422).send({ success: false, error: result.error })
        }

        const pool = getPool()
        await pool.query(
            `INSERT INTO mess_menus (uploaded_by, hostel_name, meal_type, menu_date, items, raw_ocr_text)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (hostel_name, meal_type, menu_date)
             DO UPDATE SET items = $5, raw_ocr_text = $6, verified = false`,
            [user.userId, hostel_name, meal_type, menu_date, JSON.stringify(result.data), result.raw_text]
        )

        log.info({ hostel_name, meal_type, menu_date, items: result.data?.length }, 'Menu uploaded')
        return reply.send({ success: true, data: result.data })
    })

    // POST /admin/upload/event
    fastify.post<{ Body: EventUploadBody }>('/admin/upload/event', async (request, reply) => {
        const { image_base64, event_name, venue, event_date, description, tags: rawTags } = request.body ?? {} as EventUploadBody

        if (!image_base64) {
            return reply.code(400).send({ success: false, error: 'Missing required field: image_base64' })
        }

        // For events, require mess_admin role only (no hostel match fallback)
        const user = await resolveAdminUser(request, reply, null)
        if (!user) return
        if (user.role !== 'mess_admin') {
            return reply.code(403).send({ success: false, error: 'Forbidden: mess_admin role required for event upload' })
        }

        const imageBuffer = Buffer.from(image_base64, 'base64')
        const result = await parseEventPhoto(imageBuffer)

        if (!result.success) {
            log.warn({ event_name }, 'Event OCR failed')
            return reply.code(422).send({ success: false, error: result.error })
        }

        // Merge form fields with OCR result (form fields take precedence)
        const eventData = result.data!
        const finalTags: string[] = parseTags(rawTags) ?? eventData.tags ?? []

        const pool = getPool()
        await pool.query(
            `INSERT INTO local_events (uploaded_by, event_name, venue, event_date, description, tags, raw_ocr_text)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                user.userId,
                event_name || eventData.event_name,
                venue || eventData.venue,
                event_date || eventData.event_date,
                description || eventData.description,
                finalTags,
                result.raw_text,
            ]
        )

        log.info({ event_name: event_name || eventData.event_name }, 'Event uploaded')
        return reply.send({ success: true, data: { ...eventData, tags: finalTags } })
    })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseTags(raw: string | string[] | undefined): string[] | null {
    if (!raw) return null
    if (Array.isArray(raw)) return raw.filter(Boolean)
    return raw.split(',').map(t => t.trim()).filter(Boolean)
}
