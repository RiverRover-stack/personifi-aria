/**
 * Unit tests for Alpha Tool Definitions (#129)
 *
 * Validates that every tool schema is well-formed and passes Groq's function
 * calling contract: correct structure, required fields present in properties,
 * valid JSON Schema types, and no duplicate names.
 */

import { describe, it, expect } from 'vitest'
import { ALPHA_TOOL_DEFINITIONS, ALPHA_TOOL_NAMES } from './tool-definitions.js'

// ─── Schema Validator ─────────────────────────────────────────────────────────

/**
 * Validates a single tool definition against Groq's function-calling schema.
 * Returns an array of error messages (empty = valid).
 */
function validateToolSchema(tool: (typeof ALPHA_TOOL_DEFINITIONS)[number]): string[] {
    const errors: string[] = []
    const name = tool?.function?.name ?? '(unknown)'

    if (tool.type !== 'function') errors.push(`${name}: type must be "function"`)
    if (!tool.function) { errors.push(`${name}: missing .function`); return errors }

    if (!tool.function.name) errors.push(`${name}: missing function.name`)
    if (typeof tool.function.name !== 'string') errors.push(`${name}: function.name must be string`)
    if (!tool.function.description || tool.function.description.trim().length < 10)
        errors.push(`${name}: function.description too short or missing`)

    const params = tool.function.parameters
    if (!params) { errors.push(`${name}: missing function.parameters`); return errors }
    if (params.type !== 'object') errors.push(`${name}: parameters.type must be "object"`)
    if (!params.properties || typeof params.properties !== 'object')
        errors.push(`${name}: parameters.properties must be an object`)
    if (!Array.isArray(params.required)) errors.push(`${name}: parameters.required must be an array`)

    // Every required field must exist in properties
    if (Array.isArray(params.required) && params.properties) {
        for (const req of params.required as string[]) {
            if (!(req in (params.properties as object))) {
                errors.push(`${name}: required field "${req}" not found in properties`)
            }
        }
    }

    // Each property must have a valid type
    const VALID_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object', 'integer'])
    if (params.properties) {
        for (const [propName, propDef] of Object.entries(params.properties as Record<string, any>)) {
            if (!propDef.type) errors.push(`${name}.${propName}: missing type`)
            else if (!VALID_TYPES.has(propDef.type)) errors.push(`${name}.${propName}: invalid type "${propDef.type}"`)
            if (!propDef.description) errors.push(`${name}.${propName}: missing description`)
        }
    }

    return errors
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ALPHA_TOOL_DEFINITIONS — schema validation', () => {
    it('exports exactly 8 tool definitions', () => {
        expect(ALPHA_TOOL_DEFINITIONS).toHaveLength(8)
    })

    it('has no duplicate tool names', () => {
        const names = ALPHA_TOOL_DEFINITIONS.map(t => t.function.name)
        const unique = new Set(names)
        expect(unique.size).toBe(names.length)
    })

    it('ALPHA_TOOL_NAMES set matches definition names', () => {
        const defNames = new Set(ALPHA_TOOL_DEFINITIONS.map(t => t.function.name))
        expect(ALPHA_TOOL_NAMES).toEqual(defNames)
    })

    it.each(ALPHA_TOOL_DEFINITIONS)('$function.name passes schema validation', (tool) => {
        const errors = validateToolSchema(tool)
        expect(errors).toEqual([])
    })

    it('contains all 8 expected tool names', () => {
        const expected = [
            'cab_compare',
            'place_search',
            'weather_check',
            'food_finder',
            'price_alert',
            'event_lookup',
            'friend_activity',
            'set_reminder',
        ]
        for (const name of expected) {
            expect(ALPHA_TOOL_NAMES.has(name)).toBe(true)
        }
    })
})

describe('cab_compare', () => {
    const tool = ALPHA_TOOL_DEFINITIONS.find(t => t.function.name === 'cab_compare')!

    it('has pickup and destination as required', () => {
        expect(tool.function.parameters.required).toContain('pickup')
        expect(tool.function.parameters.required).toContain('destination')
    })

    it('passengers is optional', () => {
        expect(tool.function.parameters.required).not.toContain('passengers')
        expect(tool.function.parameters.properties).toHaveProperty('passengers')
    })

    it('passengers is type number', () => {
        const props = tool.function.parameters.properties as any
        expect(props.passengers.type).toBe('number')
    })
})

describe('place_search', () => {
    const tool = ALPHA_TOOL_DEFINITIONS.find(t => t.function.name === 'place_search')!

    it('only query is required', () => {
        expect(tool.function.parameters.required).toEqual(['query'])
    })

    it('has openNow as boolean', () => {
        const props = tool.function.parameters.properties as any
        expect(props.openNow.type).toBe('boolean')
    })

    it('has minRating as number', () => {
        const props = tool.function.parameters.properties as any
        expect(props.minRating.type).toBe('number')
    })
})

describe('weather_check', () => {
    const tool = ALPHA_TOOL_DEFINITIONS.find(t => t.function.name === 'weather_check')!

    it('requires only location', () => {
        expect(tool.function.parameters.required).toEqual(['location'])
    })
})

describe('food_finder', () => {
    const tool = ALPHA_TOOL_DEFINITIONS.find(t => t.function.name === 'food_finder')!

    it('requires query and location', () => {
        expect(tool.function.parameters.required).toContain('query')
        expect(tool.function.parameters.required).toContain('location')
    })
})

describe('price_alert', () => {
    const tool = ALPHA_TOOL_DEFINITIONS.find(t => t.function.name === 'price_alert')!

    it('requires only query', () => {
        expect(tool.function.parameters.required).toEqual(['query'])
    })

    it('has enum on category field', () => {
        const props = tool.function.parameters.properties as any
        expect(Array.isArray(props.category.enum)).toBe(true)
        expect(props.category.enum).toContain('grocery')
    })
})

describe('event_lookup', () => {
    const tool = ALPHA_TOOL_DEFINITIONS.find(t => t.function.name === 'event_lookup')!

    it('requires query and location', () => {
        expect(tool.function.parameters.required).toContain('query')
        expect(tool.function.parameters.required).toContain('location')
    })

    it('date is optional', () => {
        expect(tool.function.parameters.required).not.toContain('date')
        expect(tool.function.parameters.properties).toHaveProperty('date')
    })
})

describe('set_reminder', () => {
    const tool = ALPHA_TOOL_DEFINITIONS.find(t => t.function.name === 'set_reminder')!

    it('requires message and time', () => {
        expect(tool.function.parameters.required).toContain('message')
        expect(tool.function.parameters.required).toContain('time')
    })
})

describe('friend_activity', () => {
    const tool = ALPHA_TOOL_DEFINITIONS.find(t => t.function.name === 'friend_activity')!

    it('requires friendId', () => {
        expect(tool.function.parameters.required).toContain('friendId')
    })
})
