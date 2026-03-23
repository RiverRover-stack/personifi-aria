/**
 * Shared Telegram Mini App types for Phase 3 UX layer.
 * Used by webapp-validation.ts, webapp-router.ts, and all handlers.
 */

export interface WebAppUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
  is_premium?: boolean
}

export interface WebAppInitData {
  query_id?: string
  user?: WebAppUser
  auth_date: number
  hash: string
  start_param?: string
  chat_type?: string
  chat_instance?: string
}

export interface WebAppDataPayload {
  type: 'location' | 'friend_select' | 'onboarding' | 'menu_action'
  action: string
  [key: string]: unknown
}
