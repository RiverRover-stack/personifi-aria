/**
 * OCR Upload Endpoints — Phase 5, Issue #135
 *
 * Registers:
 *   POST /admin/upload/menu   — accepts JSON { image_base64, hostel_name, meal_type, menu_date }
 *   POST /admin/upload/event  — accepts JSON { image_base64, event_name, venue, event_date, description, tags }
 *
 * Auth: user must have role='mess_admin' OR hostel_name match.
 * Both routes call the OCR engine and persist results to DB.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { getPool } from '../character/session-store.js'
import { parseMenuPhoto, parseEventPhoto } from './index.js'
import { logger as rootLogger } from '../logger.js'

const log = rootLogger.child({ module: 'ocr-upload' })

// ─── Types ────────────────────────────────────────────────────────────────────

interface MenuUploadBody {
    image_base64: string
    hostel_name: string
    meal_type: 'breakfast' | 'lunch' | 'snack' | 'dinner'
    menu_date: string  // YYYY-MM-DD
    user_id: string    // injected by auth check
}

interface EventUploadBody {
    image_base64: string
    event_name: string
    venue?: string
    event_date?: string  // ISO 8601
    description?: string
    tags?: string | string[]  // comma-separated string OR array
    user_id: string
}

// ─── Auth helper ─────────────────────────────────────────────────────────────

async function assertAdminAccess(
    userId: string,
    hostelName: string,
    reply: FastifyReply
): Promise<{ user_id: string; role: string; hostel_name: string | null } | null> {
    const pool = getPool()
    const { rows } = await pool.query<{ user_id: string; role: string; hostel_name: string | null }>(
        `SELECT user_id, role, hostel_name FROM users WHERE user_id = $1 LIMIT 1`,
        [userId]
    )
    const user = rows[0]
    if (!user) {
        reply.code(403).send({ success: false, error: 'Forbidden' })
        return null
    }
    if (user.role !== 'mess_admin' && user.hostel_name !== hostelName) {
        reply.code(403).send({ success: false, error: 'Forbidden' })
        return null
    }
    return user
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export async function registerOcrRoutes(fastify: FastifyInstance): Promise<void> {

    // POST /admin/upload/menu
    fastify.post<{ Body: MenuUploadBody }>('/admin/upload/menu', async (request, reply) => {
        const { image_base64, hostel_name, meal_type, menu_date } = request.body ?? {} as MenuUploadBody

        if (!image_base64 || !hostel_name || !meal_type || !menu_date) {
            return reply.code(400).send({ success: false, error: 'Missing required fields: image_base64, hostel_name, meal_type, menu_date' })
        }

        // Extract user_id from session header (X-User-Id) or body
        const userId: string = (request.headers['x-user-id'] as string) || request.body?.user_id
        if (!userId) {
            return reply.code(401).send({ success: false, error: 'Unauthorized' })
        }

        const user = await assertAdminAccess(userId, hostel_name, reply)
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
            [userId, hostel_name, meal_type, menu_date, JSON.stringify(result.data), result.raw_text]
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

        const userId: string = (request.headers['x-user-id'] as string) || request.body?.user_id
        if (!userId) {
            return reply.code(401).send({ success: false, error: 'Unauthorized' })
        }

        // For events, require mess_admin only (no hostel match check)
        const pool = getPool()
        const { rows } = await pool.query<{ role: string }>(
            `SELECT role FROM users WHERE user_id = $1 LIMIT 1`,
            [userId]
        )
        if (!rows[0] || rows[0].role !== 'mess_admin') {
            return reply.code(403).send({ success: false, error: 'Forbidden' })
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

        await pool.query(
            `INSERT INTO local_events (uploaded_by, event_name, venue, event_date, description, tags, raw_ocr_text)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                userId,
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
