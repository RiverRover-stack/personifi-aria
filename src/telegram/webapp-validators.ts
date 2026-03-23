/**
 * Zod validation schemas for Telegram Mini App payload types.
 * Used in webapp-router.ts before passing data to handlers.
 */

import { z } from 'zod'

export const LocationPayloadSchema = z.object({
  type: z.literal('location'),
  action: z.enum(['select', 'save', 'delete']),
  area: z.string().min(1).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().max(50).optional(),
})

export const FriendPayloadSchema = z.object({
  type: z.literal('friend_select'),
  action: z.enum(['add', 'remove']),
  friends: z.array(z.string().uuid()).min(1).max(20),
})

export const OnboardingPayloadSchema = z.object({
  type: z.literal('onboarding'),
  preferences: z.record(z.string(), z.string()),
})

export const MenuActionPayloadSchema = z.object({
  type: z.literal('menu_action'),
  action: z.string().min(1).max(100),
})

export type LocationPayload = z.infer<typeof LocationPayloadSchema>
export type FriendPayload = z.infer<typeof FriendPayloadSchema>
export type OnboardingPayload = z.infer<typeof OnboardingPayloadSchema>
export type MenuActionPayload = z.infer<typeof MenuActionPayloadSchema>
