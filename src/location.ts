/**
 * Location utilities for Aria.
 * Handles GPS-based geocoding, "near me" detection, and saved locations CRUD.
 */

import { getPool } from './character/session-store.js'

export interface ResolvedLocation {
    lat: number
    lng: number
    address: string
}

/**
 * Pending location requests: userId → { toolHint, chatId }
 * Set when Aria asks the user for their location.
 * Cleared when the user sends their GPS coordinates.
 */
export const pendingLocationStore = new Map<string, { toolHint: string; chatId: string; originalMessage?: string }>()

/**
 * Reverse geocode lat/lng to a human-readable address.
 * Falls back to "lat, lng" string if GOOGLE_MAPS_API_KEY is not set.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string> {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`

    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}&result_type=locality|sublocality|neighborhood`
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
        if (!resp.ok) throw new Error(`Geocoding API ${resp.status}`)
        const data = await resp.json() as { results?: { formatted_address: string }[] }
        const address = data.results?.[0]?.formatted_address
        return address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`
    } catch (err) {
        console.warn('[Location] Reverse geocoding failed:', err)
        return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
    }
}

const NEAR_ME_PATTERNS = [
    /near\s+me/i,
    /near\s+my\s+(location|place|home|area)/i,
    /close\s+to\s+me/i,
    /around\s+me/i,
    /in\s+my\s+area/i,
    /\bnearby\b/i,
]

const LOCATION_SENSITIVE_TOOL_HINTS = [
    'compare_food_prices',
    'compare_grocery_prices',
    'search_swiggy_food',
    'search_dineout',
    'search_places',
]

function hasExplicitLocationInMessage(msg: string): boolean {
    return /\b(?:in|at|from|near)\s+[a-z][a-z\s]{2,40}\b/i.test(msg)
}

/**
 * Determine if Aria should ask the user for their location.
 * Returns true when:
 *   - Message contains a "near me" pattern, OR
 *   - Tool is food/grocery related and user has no saved homeLocation
 */
export function shouldRequestLocation(
    msg: string,
    homeLocation: string | undefined | null,
    toolHint: string | undefined | null
): boolean {
    // "near me" pattern always triggers location request
    if (NEAR_ME_PATTERNS.some(p => p.test(msg))) return true

    // Location-sensitive tool but no saved home location and user didn't name an area.
    if (!homeLocation && toolHint && LOCATION_SENSITIVE_TOOL_HINTS.includes(toolHint)) {
        return !hasExplicitLocationInMessage(msg)
    }

    return false
}

// ─── Saved Locations CRUD ────────────────────────────────────────────────────

export interface SavedLocation {
    id: string
    label: string
    area: string
    lat: number
    lng: number
    is_default: boolean
}

export interface SavedLocationInput {
    label: string
    area: string
    lat: number
    lng: number
    is_default?: boolean
}

export async function getSavedLocations(userId: string): Promise<SavedLocation[]> {
    const pool = getPool()
    const { rows } = await pool.query<SavedLocation>(
        `SELECT id, label, area, lat, lng, is_default
         FROM saved_locations
         WHERE user_id = $1
         ORDER BY is_default DESC, created_at ASC`,
        [userId]
    )
    return rows
}

export async function upsertSavedLocation(userId: string, loc: SavedLocationInput): Promise<void> {
    const pool = getPool()
    await pool.query(
        `INSERT INTO saved_locations (user_id, label, area, lat, lng, is_default, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id, LOWER(label)) DO UPDATE SET
             area = EXCLUDED.area,
             lat = EXCLUDED.lat,
             lng = EXCLUDED.lng,
             is_default = EXCLUDED.is_default,
             updated_at = NOW()`,
        [userId, loc.label, loc.area, loc.lat, loc.lng, loc.is_default ?? false]
    )
}

export async function deleteSavedLocation(userId: string, label: string): Promise<void> {
    const pool = getPool()
    await pool.query(
        `DELETE FROM saved_locations WHERE user_id = $1 AND LOWER(label) = LOWER($2)`,
        [userId, label]
    )
}

export async function getDefaultLocation(userId: string): Promise<SavedLocation | null> {
    const pool = getPool()
    const { rows } = await pool.query<SavedLocation>(
        `SELECT id, label, area, lat, lng, is_default
         FROM saved_locations
         WHERE user_id = $1 AND is_default = TRUE
         LIMIT 1`,
        [userId]
    )
    return rows[0] ?? null
}
