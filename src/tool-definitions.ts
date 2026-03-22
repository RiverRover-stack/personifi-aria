/**
 * Alpha Tool Definitions (#129)
 *
 * 8 curated Groq/Together-compatible function schemas for Alpha's native
 * function calling. These are a focused subset of the 21 tools in
 * src/tools/index.ts, optimised for Alpha's 1-2 call reactive pipeline.
 *
 * Alpha tool names are distinct from the legacy tool names so that both
 * pipelines can coexist during the transition (no accidental cross-wiring).
 */

import type { ProviderTool } from './llm/providers/types.js'

// ─── Definitions ─────────────────────────────────────────────────────────────

export const ALPHA_TOOL_DEFINITIONS: ProviderTool[] = [
    {
        type: 'function',
        function: {
            name: 'cab_compare',
            description: 'Compare cab/ride prices across Ola, Uber, and Rapido for a given pickup and destination. Use when the user wants to know ride options or costs.',
            parameters: {
                type: 'object',
                properties: {
                    pickup: {
                        type: 'string',
                        description: 'Pickup location (area name, landmark, or full address)',
                    },
                    destination: {
                        type: 'string',
                        description: 'Drop-off destination (area name, landmark, or full address)',
                    },
                    passengers: {
                        type: 'number',
                        description: 'Number of passengers (default 1)',
                    },
                },
                required: ['pickup', 'destination'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'place_search',
            description: 'Search for places, restaurants, cafes, shops, or services near a location. Use when the user asks for recommendations or where to find something.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'What to search for (e.g. "coffee shops", "ATM", "pharmacy near me")',
                    },
                    location: {
                        type: 'string',
                        description: 'Area or neighbourhood to search in. Omit to use user\'s home location.',
                    },
                    openNow: {
                        type: 'boolean',
                        description: 'Filter to only currently open places',
                    },
                    minRating: {
                        type: 'number',
                        description: 'Minimum Google rating (1-5)',
                    },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'weather_check',
            description: 'Get current weather and forecast for a location. Use when the user asks about weather, whether to carry an umbrella, outdoor plans, etc.',
            parameters: {
                type: 'object',
                properties: {
                    location: {
                        type: 'string',
                        description: 'City or area name (e.g. "Indiranagar, Bangalore")',
                    },
                },
                required: ['location'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'food_finder',
            description: 'Compare food prices and delivery options across Swiggy, Zomato, and other platforms for a given dish or restaurant. Use when the user wants to order food or find the best deal.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'What food or restaurant to search for (e.g. "biryani", "McDonald\'s", "healthy salad")',
                    },
                    location: {
                        type: 'string',
                        description: 'Area to search in. Omit to use user\'s home location.',
                    },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'price_alert',
            description: 'Compare prices for a product or grocery item across quick-commerce platforms (Blinkit, Zepto, Instamart). Use when the user asks about grocery prices or wants to find the cheapest option.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Product or item to compare (e.g. "milk 1L", "Lay\'s chips", "paneer 500g")',
                    },
                    location: {
                        type: 'string',
                        description: 'Area to search in. Omit to use user\'s home location.',
                    },
                    category: {
                        type: 'string',
                        description: 'Product category hint: "grocery", "snacks", "beverages", "personal_care"',
                        enum: ['grocery', 'snacks', 'beverages', 'personal_care', 'other'],
                    },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'event_lookup',
            description: 'Find events, shows, exhibitions, or activities happening in a city or area. Use when the user asks what\'s on, things to do, or plans for the weekend.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Type of event or activity (e.g. "concerts", "art exhibitions", "standup comedy", "things to do this weekend")',
                    },
                    location: {
                        type: 'string',
                        description: 'City or area to search (e.g. "Bangalore", "Koramangala")',
                    },
                    date: {
                        type: 'string',
                        description: 'Date or time range in natural language (e.g. "this weekend", "tomorrow", "next week")',
                    },
                },
                required: ['query', 'location'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'friend_activity',
            description: 'Check what a friend is up to or their recent activity. Use when the user asks about a specific friend\'s plans or location.',
            parameters: {
                type: 'object',
                properties: {
                    friendId: {
                        type: 'string',
                        description: 'Friend\'s user ID or name as known to the system',
                    },
                },
                required: ['friendId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'set_reminder',
            description: 'Set a reminder or alarm for the user at a specific time. Use when the user asks to be reminded about something.',
            parameters: {
                type: 'object',
                properties: {
                    message: {
                        type: 'string',
                        description: 'What to remind the user about',
                    },
                    time: {
                        type: 'string',
                        description: 'When to send the reminder, in natural language (e.g. "in 30 minutes", "at 7pm", "tomorrow morning")',
                    },
                },
                required: ['message', 'time'],
            },
        },
    },
]

// ─── Name Registry ────────────────────────────────────────────────────────────

/** Fast O(1) lookup: is this tool name a valid Alpha tool? */
export const ALPHA_TOOL_NAMES: ReadonlySet<string> = new Set(
    ALPHA_TOOL_DEFINITIONS.map(t => t.function.name)
)
