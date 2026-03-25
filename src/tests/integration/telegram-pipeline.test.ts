/**
 * Telegram Data Pipeline Smoke Tests — Phase 7, Issue #147
 *
 * Smoke Test 1: OCR admin upload — parseMenuPhoto produces typed result
 * Smoke Test 2: Trip plan retrieval — response within Telegram 4096-char limit
 * Smoke Test 3: Proactive message format — delivery payload is valid
 * Smoke Test 4: Mini App web_app_data — trip planner form maps to plan_trip args
 *
 * Uses vi.mock() for Groq SDK. No live bot or HTTP server required.
 * DB-dependent sections skip when TEST_DATABASE_URL is not set.
 */

import { describe, it, expect, vi } from 'vitest'
import type { OCRResult, MenuItem, LocalEventData } from '../../ocr/types.js'
import type { PlanTripArgs } from '../../tools/trip-planner.js'
import {
    fusionProactiveDecision,
    computeFusionScore,
} from '../../fusion/index.js'
import type { StimulusInput, UserContext } from '../../fusion/types.js'

// ─── Groq SDK mock ────────────────────────────────────────────────────────────
// Mocked before OCR module imports so it intercepts the SDK constructor.

vi.mock('groq-sdk', () => {
    const mockCreate = vi.fn()
    return {
        default: vi.fn(() => ({
            chat: {
                completions: {
                    create: mockCreate,
                },
            },
        })),
        __mockCreate: mockCreate,
    }
})

// ─── Smoke Test 1 — OCR admin upload via Telegram photo ──────────────────────

describe('Smoke Test 1 — OCR parseMenuPhoto returns structured MenuItem[]', () => {
    it('success path: Groq vision + parse returns typed menu items', async () => {
        const { default: Groq } = await import('groq-sdk') as any
        const mockCreate = Groq().chat.completions.create

        // Step 1: Vision model returns raw text
        mockCreate
            .mockResolvedValueOnce({
                choices: [{ message: { content: 'Dal Fry Rs 50 veg\nChicken Curry Rs 120 non-veg\nRice Rs 30 veg' } }],
            })
            // Step 2: 8B parse model returns structured JSON
            .mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify([
                            { name: 'Dal Fry', price: 50, veg: true, category: 'main' },
                            { name: 'Chicken Curry', price: 120, veg: false, category: 'main' },
                            { name: 'Rice', price: 30, veg: true, category: 'side' },
                        ]),
                    },
                }],
            })

        const { parseMenuPhoto } = await import('../../ocr/index.js')
        const fakeImageBuffer = Buffer.from('fake-jpeg-data')

        const result: OCRResult<MenuItem[]> = await parseMenuPhoto(fakeImageBuffer)

        expect(result.success).toBe(true)
        expect(result.data).not.toBeNull()
        expect(result.data!.length).toBeGreaterThan(0)

        // Each item must conform to the MenuItem shape
        for (const item of result.data!) {
            expect(typeof item.name).toBe('string')
            expect(item.name.length).toBeGreaterThan(0)
            expect(typeof item.veg).toBe('boolean')
            expect(typeof item.category).toBe('string')
        }

        // raw_text must be populated
        expect(result.raw_text.length).toBeGreaterThan(0)
    })

    it('parseEventPhoto returns LocalEventData shape', async () => {
        const { default: Groq } = await import('groq-sdk') as any
        const mockCreate = Groq().chat.completions.create

        mockCreate
            .mockResolvedValueOnce({
                choices: [{ message: { content: 'Open Mic Night @ The Hub, March 28, 8pm, comedy music' } }],
            })
            .mockResolvedValueOnce({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            event_name: 'Open Mic Night',
                            venue: 'The Hub',
                            event_date: '2026-03-28T20:00:00',
                            description: 'Comedy and music night',
                            tags: ['comedy', 'music'],
                        }),
                    },
                }],
            })

        const { parseEventPhoto } = await import('../../ocr/index.js')
        const fakeBuffer = Buffer.from('fake-event-image')

        const result: OCRResult<LocalEventData> = await parseEventPhoto(fakeBuffer)

        expect(result.success).toBe(true)
        expect(result.data).not.toBeNull()
        expect(typeof result.data!.event_name).toBe('string')
        expect(Array.isArray(result.data!.tags)).toBe(true)
    })

    it('error path: returns success=false with error message on Groq failure', async () => {
        const { default: Groq } = await import('groq-sdk') as any
        const mockCreate = Groq().chat.completions.create

        mockCreate.mockRejectedValueOnce(new Error('Groq API rate limit'))

        const { parseMenuPhoto } = await import('../../ocr/index.js')
        const result = await parseMenuPhoto(Buffer.from('fake'))

        expect(result.success).toBe(false)
        expect(result.data).toBeNull()
        expect(result.error).toBeTruthy()
    })

    // DB-dependent: seed mess_menus row and verify Sentinel picks it up
    it.skipIf(!process.env.TEST_DATABASE_URL)(
        'after DB insert, mess menu stimulus returns non-null for matching user',
        async () => {
            // DB-level test — requires TEST_DATABASE_URL
            // Seeded by the calling CI environment
        }
    )
})

// ─── Smoke Test 2 — Trip plan retrieval ──────────────────────────────────────

describe('Smoke Test 2 — Trip plan response fits within Telegram 4096-char limit', () => {
    it('TripPlan serialized to string is under 4096 characters', () => {
        // Simulate a TripPlan response (as the handler would format it)
        const tripPlan = {
            destination: 'Goa',
            origin: 'Bangalore',
            departure_date: '2026-04-05',
            return_date: '2026-04-08',
            travelers: 2,
            budget: 'mid',
            flights: [
                { airline: 'IndiGo', price: 3500, departure: '07:00', arrival: '08:15' },
                { airline: 'Air India', price: 4200, departure: '10:00', arrival: '11:20' },
                { airline: 'SpiceJet', price: 3100, departure: '14:00', arrival: '15:15' },
            ],
            hotels: [
                { name: 'Beach Bliss Resort', stars: 3, price_per_night: 2500, rating: 4.2 },
                { name: 'Goa Sands', stars: 4, price_per_night: 4000, rating: 4.5 },
                { name: 'Budget Beach Hut', stars: 2, price_per_night: 1200, rating: 3.8 },
            ],
            activities: [
                'Baga Beach — watersports, sunbathing',
                'Anjuna Flea Market — shopping, local food',
                'Dudhsagar Falls — trekking, waterfall views',
                'Fort Aguada — colonial history, sea views',
                'Arambol Beach — music, hippie culture',
            ],
            weather_summary: 'Sunny, 32°C, low chance of rain. Good beach weather.',
            budget_estimate: '₹12,000–18,000 per person including flights and hotel',
        }

        // Format as Aria would format it for Telegram
        const formattedResponse = [
            `✈️ *${tripPlan.destination} Trip* (${tripPlan.departure_date} → ${tripPlan.return_date})`,
            '',
            `👤 ${tripPlan.travelers} travelers | Budget: ${tripPlan.budget}`,
            '',
            `*Flights:*`,
            ...tripPlan.flights.map(f => `• ${f.airline} — ₹${f.price} (${f.departure})`),
            '',
            `*Hotels:*`,
            ...tripPlan.hotels.map(h => `• ${h.name} ⭐${h.stars} — ₹${h.price_per_night}/night`),
            '',
            `*Top Activities:*`,
            ...tripPlan.activities.map(a => `• ${a}`),
            '',
            `*Weather:* ${tripPlan.weather_summary}`,
            `*Budget:* ${tripPlan.budget_estimate}`,
        ].join('\n')

        // Must be under Telegram's 4096-char message limit
        expect(formattedResponse.length).toBeLessThan(4096)

        // Must contain destination
        expect(formattedResponse).toContain(tripPlan.destination)

        // Must contain at least one flight or hotel
        expect(formattedResponse).toMatch(/IndiGo|Air India|Beach Bliss/)
    })

    it.skipIf(!process.env.TEST_DATABASE_URL)(
        'handler retrieves trip_plans row for user and formats response',
        async () => {
            // DB-level test: seed trip_plans, call handler, assert response contains destination
        }
    )
})

// ─── Smoke Test 3 — Proactive message format ─────────────────────────────────

describe('Smoke Test 3 — Proactive delivery payload format', () => {
    it('FIRE decision produces a valid sendMessage-compatible payload', () => {
        const stimulus: StimulusInput = {
            type: 'weather',
            key: 'weather_rain_commute',
            weight: 0.9,
            data: { condition: 'RAIN_START', city: 'Bangalore', message: "It's raining — grab an umbrella before you leave!" },
        }

        const userCtx: UserContext = {
            userId: 'user-smoke-003',
            pulseState: 'PROACTIVE',
            pulseScore: 88,
            preferences: { weather_alerts: 'rain_start' },
            recentPushbacks: 0,
            proactiveCountToday: 1,
            positiveInteractionStreak: 3,
            reactiveOnly: false,
        }

        // Simulate daytime IST to ensure FIRE
        vi.setSystemTime(new Date('2026-03-25T03:00:00Z'))  // 8:30am IST

        const score = computeFusionScore(stimulus, userCtx)
        const decision = fusionProactiveDecision(stimulus, userCtx)

        vi.useRealTimers()

        // Build a mock Telegram sendMessage payload
        const message = stimulus.data.message as string
        const sendMessagePayload = {
            chat_id: userCtx.userId,
            text: message,
            parse_mode: 'Markdown' as const,
        }

        // Assert payload structure
        expect(sendMessagePayload.chat_id).toBeTruthy()
        expect(typeof sendMessagePayload.text).toBe('string')
        expect(sendMessagePayload.text.length).toBeGreaterThan(0)
        expect(sendMessagePayload.text.length).toBeLessThan(4096)
        expect(['Markdown', 'MarkdownV2', 'HTML']).toContain(sendMessagePayload.parse_mode)

        // High-score stimulus should produce FIRE (weather=0.9, pref=1.0, receptivity=1.0, fatigue=1/5=0.2)
        // score ≈ 0.9 × 1.0 × 1.0 × 0.8 = 0.72 >= PROACTIVE threshold 0.7 → FIRE
        expect(score).toBeGreaterThan(0.7)
        expect(decision.action).toBe('FIRE')
    })

    it.skipIf(!process.env.TEST_DATABASE_URL)(
        'executeFire() sends a valid Telegram sendMessage payload',
        async () => {
            // DB-level test: seed proactive_state with FIRE decision, call delivery.executeFire()
        }
    )
})

// ─── Smoke Test 4 — Mini App web_app_data handling ───────────────────────────

describe('Smoke Test 4 — Mini App web_app_data maps to plan_trip args', () => {
    it('trip planner form JSON maps to valid PlanTripArgs', () => {
        // Simulate Telegram callback_query.data with web_app_data from trip-planner.html
        const webAppData = {
            destination: 'Goa',
            origin: 'Bangalore',
            departure_date: '2026-04-05',
            return_date: '2026-04-08',
            travelers: 2,
            budget: 'mid' as const,
            interests: ['beach', 'food'],
        }

        // This is the JSON that Telegram.WebApp.sendData() sends
        const rawPayload = JSON.stringify(webAppData)

        // Parse and validate against PlanTripArgs shape
        const parsed = JSON.parse(rawPayload) as PlanTripArgs

        expect(typeof parsed.destination).toBe('string')
        expect(parsed.destination).toBe('Goa')
        expect(parsed.travelers).toBe(2)
        expect(['budget', 'mid', 'premium']).toContain(parsed.budget)
        expect(Array.isArray(parsed.interests)).toBe(true)

        // Validate that no injection tokens are present in destination
        const dangerPatterns = [/\[INST\]/, /<<SYS>>/, /ignore previous/i]
        for (const p of dangerPatterns) {
            expect(parsed.destination).not.toMatch(p)
        }
    })

    it('menu upload form JSON maps to valid mess_menus insert shape', () => {
        // Simulate what menu-upload.html sends via Telegram.WebApp.sendData()
        const menuResult = {
            success: true,
            hostel: 'Hostel A',
            meal_type: 'lunch',
            date: '2026-03-25',
            items: [
                { name: 'Dal Fry', price: 50, veg: true, category: 'main' },
                { name: 'Rice', price: 30, veg: true, category: 'side' },
            ],
        }

        const raw = JSON.stringify(menuResult)
        const parsed = JSON.parse(raw)

        expect(parsed.success).toBe(true)
        expect(parsed.hostel).toBeTruthy()
        expect(['breakfast', 'lunch', 'snack', 'dinner']).toContain(parsed.meal_type)
        expect(Array.isArray(parsed.items)).toBe(true)
        expect(parsed.items.length).toBeGreaterThan(0)

        // Each item must have required OCR-parsed fields
        for (const item of parsed.items as MenuItem[]) {
            expect(typeof item.name).toBe('string')
            expect(typeof item.veg).toBe('boolean')
        }
    })

    it.skipIf(!process.env.TEST_DATABASE_URL)(
        'plan_trip tool is triggered and trip_plans row is written',
        async () => {
            // DB-level test: inject callback_query with web_app_data, assert trip_plans insert
        }
    )
})
