/**
 * Trip Planner Composite Tool — Phase 5, Issue #138
 *
 * Orchestrates parallel calls to flights, hotels, places, and weather,
 * composes a TripPlan, persists to trip_plans, and schedules 3 Sentinel
 * follow-ups via proactive_state.
 */

import { getPool } from '../character/session-store.js'
import { searchFlightsMCP } from './travel-mcp.js'
import { searchHotelsMCP } from './travel-mcp.js'
import { searchPlaces } from './places.js'
import { getWeather } from './weather.js'
import { getDirections } from './directions.js'
import { logger } from '../logger.js'
import type { ToolExecutionResult } from '../hooks.js'

const log = logger.child({ module: 'trip-planner' })

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlanTripArgs {
    destination: string
    origin?: string
    departure_date?: string       // YYYY-MM-DD
    return_date?: string          // YYYY-MM-DD
    travelers?: number
    budget?: 'budget' | 'mid' | 'premium'
    interests?: string[]
}

interface TripPlan {
    destination: string
    origin: string
    departure_date: string | null
    return_date: string | null
    travelers: number
    budget: string
    flights: unknown[]
    hotels: unknown[]
    activities: unknown[]
    weather_summary: string
    budget_estimate: string
    trip_id?: string
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const tripPlannerDefinition = {
    name: 'plan_trip',
    description: 'Plan a trip with flights, hotels, activities, and weather for a destination. Use when the user asks to plan a trip, book a holiday, or explore travel options.',
    parameters: {
        type: 'object' as const,
        properties: {
            destination: {
                type: 'string',
                description: 'Destination city or airport code (e.g. "Goa", "BOM")',
            },
            origin: {
                type: 'string',
                description: 'Origin city (optional — defaults to user home location)',
            },
            departure_date: {
                type: 'string',
                description: 'Departure date in YYYY-MM-DD format (optional)',
            },
            return_date: {
                type: 'string',
                description: 'Return date in YYYY-MM-DD format. Omit for one-way trip.',
            },
            travelers: {
                type: 'number',
                description: 'Number of travelers (default 1)',
            },
            budget: {
                type: 'string',
                enum: ['budget', 'mid', 'premium'],
                description: 'Budget tier (default mid)',
            },
            interests: {
                type: 'array',
                items: { type: 'string' },
                description: 'Interests to tailor activity suggestions (e.g. ["beach", "food", "culture"])',
            },
        },
        required: ['destination'],
    },
}

// ─── Origin resolver ──────────────────────────────────────────────────────────

async function resolveOrigin(userId: string, provided?: string): Promise<string> {
    if (provided) return provided
    try {
        const pool = getPool()
        const { rows } = await pool.query<{ home_location: string | null }>(
            `SELECT home_location FROM users WHERE user_id = $1 LIMIT 1`,
            [userId]
        )
        return rows[0]?.home_location ?? 'Bengaluru'
    } catch {
        return 'Bengaluru'
    }
}

// ─── Departure date helpers ───────────────────────────────────────────────────

function nextWeekendDate(): string {
    const d = new Date()
    const day = d.getDay()
    const daysUntilSat = (6 - day + 7) % 7 || 7
    d.setDate(d.getDate() + daysUntilSat)
    return d.toISOString().split('T')[0]
}

function addDays(date: string, n: number): string {
    const d = new Date(date + 'T00:00:00')
    d.setDate(d.getDate() + n)
    return d.toISOString().split('T')[0]
}

// ─── Budget helpers ───────────────────────────────────────────────────────────

function estimateBudget(budget: string, travelers: number, hasFlights: boolean): string {
    const perPax: Record<string, { flight: number; hotel: number; activities: number }> = {
        budget:  { flight: 3000,  hotel: 1500, activities: 1000 },
        mid:     { flight: 6000,  hotel: 3500, activities: 2000 },
        premium: { flight: 15000, hotel: 8000, activities: 5000 },
    }
    const tier = perPax[budget] ?? perPax.mid
    const total = (hasFlights ? tier.flight : 0) + tier.hotel + tier.activities
    return `₹${(total * travelers).toLocaleString('en-IN')}–₹${(total * travelers * 1.4).toLocaleString('en-IN')} per person`
}

// ─── Proactive follow-ups ─────────────────────────────────────────────────────

async function scheduleFollowUps(userId: string, destination: string, departureDate: string | null): Promise<void> {
    if (!departureDate) return
    try {
        const pool = getPool()
        const followUps = [
            {
                stimulus_type: 'price',
                stimulus_key: `price_drop_${destination}_${departureDate}`,
                score: 0.6,
                data: { destination, departure_date: departureDate, type: 'price_drop_watch' },
                expires_at: addDays(departureDate, -3),
            },
            {
                stimulus_type: 'weather',
                stimulus_key: `weather_check_${destination}_${departureDate}`,
                score: 0.7,
                data: { destination, departure_date: departureDate, type: 'd1_weather_check' },
                expires_at: addDays(departureDate, -1),
            },
            {
                stimulus_type: 'reminder',
                stimulus_key: `trip_reminder_${destination}_${departureDate}`,
                score: 0.8,
                data: { destination, departure_date: departureDate, type: 'day_before_reminder' },
                expires_at: departureDate,
            },
        ]

        for (const f of followUps) {
            await pool.query(
                `INSERT INTO proactive_state (user_id, stimulus_type, stimulus_key, score, data, status, expires_at)
                 VALUES ($1, $2, $3, $4, $5, 'active', $6)
                 ON CONFLICT (user_id, stimulus_key) DO NOTHING`,
                [userId, f.stimulus_type, f.stimulus_key, f.score, JSON.stringify(f.data), f.expires_at]
            )
        }
    } catch (err) {
        log.warn({ err, userId, destination }, 'Failed to schedule trip follow-ups')
    }
}

// ─── Core function ────────────────────────────────────────────────────────────

export async function planTrip(args: PlanTripArgs, userId: string): Promise<ToolExecutionResult> {
    const {
        destination,
        departure_date = nextWeekendDate(),
        return_date,
        travelers = 1,
        budget = 'mid',
        interests = [],
    } = args

    const origin = await resolveOrigin(userId, args.origin)
    const sameCity = origin.toLowerCase().trim() === destination.toLowerCase().trim()
    const checkOut = return_date ?? addDays(departure_date, 2)

    log.info({ userId, destination, origin, departure_date, travelers, budget }, 'Planning trip')

    // Parallel API calls
    const [flightRes, hotelRes, placesRes, weatherRes, directionsRes] = await Promise.allSettled([
        sameCity
            ? Promise.resolve(null)
            : searchFlightsMCP({
                  origin,
                  destination,
                  departureDate: departure_date,
                  returnDate: return_date,
                  adults: travelers,
              }),
        searchHotelsMCP({
            location: destination,
            checkInDate: departure_date,
            checkOutDate: checkOut,
            adults: travelers,
        }),
        searchPlaces({
            query: interests.length > 0 ? interests.slice(0, 2).join(' ') : `things to do in ${destination}`,
            location: destination,
        }),
        getWeather({ location: destination }),
        sameCity
            ? getDirections({ origin, destination, mode: 'driving' })
            : Promise.resolve(null),
    ])

    const flights = (flightRes.status === 'fulfilled' && flightRes.value?.success)
        ? (flightRes.value.data as unknown[])?.slice(0, 3) ?? []
        : []

    const hotels = (hotelRes.status === 'fulfilled' && hotelRes.value?.success)
        ? (hotelRes.value.data as unknown[])?.slice(0, 3) ?? []
        : []

    const activities = (placesRes.status === 'fulfilled' && placesRes.value?.success)
        ? (placesRes.value.data as unknown[])?.slice(0, 5) ?? []
        : []

    const weatherSummary = (weatherRes.status === 'fulfilled' && weatherRes.value?.success)
        ? String((weatherRes.value.data as Record<string, unknown>)?.summary ?? `Check weather for ${destination}`)
        : `Check weather for ${destination}`

    const driveInfo = sameCity && directionsRes.status === 'fulfilled' && directionsRes.value?.success
        ? directionsRes.value.data
        : null

    const plan: TripPlan = {
        destination,
        origin,
        departure_date,
        return_date: return_date ?? null,
        travelers,
        budget,
        flights: sameCity ? [] : flights,
        hotels,
        activities,
        weather_summary: weatherSummary,
        budget_estimate: estimateBudget(budget, travelers, !sameCity && flights.length > 0),
        ...(driveInfo ? { drive_info: driveInfo } : {}),
    }

    // Persist to trip_plans
    try {
        const pool = getPool()
        const { rows } = await pool.query<{ trip_id: string }>(
            `INSERT INTO trip_plans (user_id, destination, origin, start_date, end_date, itinerary, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'planning')
             RETURNING trip_id`,
            [userId, destination, origin, departure_date, checkOut, JSON.stringify(plan)]
        )
        plan.trip_id = rows[0]?.trip_id
    } catch (err) {
        log.warn({ err, userId, destination }, 'Failed to persist trip plan')
    }

    // Schedule Sentinel follow-ups
    await scheduleFollowUps(userId, destination, departure_date)

    return { success: true, data: plan }
}

// ─── BodyHooks adapter ────────────────────────────────────────────────────────

export async function planTripTool(params: Record<string, unknown> & { _userId?: string }): Promise<ToolExecutionResult> {
    const { _userId, ...args } = params
    const userId = typeof _userId === 'string' ? _userId : 'unknown'
    return planTrip(args as unknown as PlanTripArgs, userId)
}
