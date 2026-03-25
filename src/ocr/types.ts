/**
 * OCR module types — Phase 5, Issue #135
 */

export interface MenuItem {
    name: string
    price: number | null
    veg: boolean
    category: string
}

export interface LocalEventData {
    event_name: string
    venue: string
    event_date: string | null
    description: string
    tags: string[]
}

export interface OCRResult<T> {
    success: boolean
    data: T | null
    raw_text: string
    error?: string
}
