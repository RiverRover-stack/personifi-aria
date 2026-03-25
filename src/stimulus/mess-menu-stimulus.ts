/**
 * Mess Menu Stimulus — Phase 5, Issue #135
 *
 * Queries mess_menus for the user's hostel on today's date at the current meal
 * bucket. Returns a StimulusAction when a menu is found; null otherwise.
 *
 * Hostel name is looked up from user_preferences (category='accommodation').
 * Returns null outside meal-time windows or when hostel is not configured.
 */

import { getPool } from '../character/session-store.js'
import { logger as rootLogger } from '../logger.js'
import type { StimulusAction } from './stimulus-router.js'

const log = rootLogger.child({ module: 'mess-menu-stimulus' })

// ─── Types ────────────────────────────────────────────────────────────────────

type MealBucket = 'breakfast' | 'lunch' | 'snack' | 'dinner'

interface MessMenuItem {
    name: string
    price: number | null
    veg: boolean
    category: string
}

// ─── Meal-time buckets (IST hours) ───────────────────────────────────────────

function getMealBucket(hour: number): MealBucket | null {
    if (hour >= 7 && hour < 10) return 'breakfast'
    if (hour >= 11 && hour < 14) return 'lunch'
    if (hour >= 15 && hour < 17) return 'snack'
    if (hour >= 18 && hour < 22) return 'dinner'
    return null
}

function getISTHour(): number {
    const now = new Date()
    const istMs = now.getTime() + (5.5 * 60 * 60 * 1000) + (now.getTimezoneOffset() * 60 * 1000)
    return new Date(istMs).getHours()
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function getUserHostel(userId: string): Promise<string | null> {
    try {
        const pool = getPool()
        const { rows } = await pool.query<{ value: string }>(
            `SELECT value FROM user_preferences
             WHERE user_id = $1 AND category = 'accommodation'
             LIMIT 1`,
            [userId]
        )
        return rows[0]?.value ?? null
    } catch {
        return null
    }
}

async function getTodayMenu(hostelName: string, mealType: MealBucket): Promise<MessMenuItem[] | null> {
    try {
        const pool = getPool()
        const today = new Date().toISOString().split('T')[0]
        const { rows } = await pool.query<{ items: MessMenuItem[] }>(
            `SELECT items FROM mess_menus
             WHERE hostel_name = $1 AND meal_type = $2 AND menu_date = $3
             LIMIT 1`,
            [hostelName, mealType, today]
        )
        return rows[0]?.items ?? null
    } catch {
        return null
    }
}

// ─── Stimulus builder ────────────────────────────────────────────────────────

function buildMessage(mealType: MealBucket, hostelName: string, items: MessMenuItem[]): string {
    const vegItems = items.filter(i => i.veg).slice(0, 3).map(i => i.name).join(', ')
    const preview = vegItems || items.slice(0, 3).map(i => i.name).join(', ') || 'today\'s menu'
    const label = mealType.charAt(0).toUpperCase() + mealType.slice(1)
    return `${label} at ${hostelName}: ${preview}${items.length > 3 ? ` +${items.length - 3} more` : ''} 🍽️`
}

// ─── Export ───────────────────────────────────────────────────────────────────

export async function getMessMenuStimulus(userId: string): Promise<StimulusAction | null> {
    const hour = getISTHour()
    const mealType = getMealBucket(hour)
    if (!mealType) return null

    const hostelName = await getUserHostel(userId)
    if (!hostelName) return null

    const items = await getTodayMenu(hostelName, mealType)
    if (!items || items.length === 0) return null

    log.debug({ userId, hostelName, mealType, count: items.length }, 'Mess menu stimulus ready')

    return {
        type: 'food',
        priority: 4,
        message: buildMessage(mealType, hostelName, items),
        suggestedAction: 'show_mess_menu',
        hashtag: 'messMenu',
        raw: { hostelName, mealType, items, updatedAt: Date.now() } as any,
    }
}
