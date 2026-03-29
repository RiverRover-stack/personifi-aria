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

export const TripPlanPayloadSchema = z.object({
  type: z.literal('trip_plan'),
  destination: z.string().min(1).max(200),
  origin: z.string().max(200).optional(),
  departure_date: z.string().optional(),
  return_date: z.string().optional(),
  travelers: z.number().int().min(1).max(8).default(1),
  budget: z.enum(['budget', 'mid', 'premium']).default('mid'),
  interests: z.array(z.string().max(50)).max(10).default([]),
})

export const EventPayloadSchema = z.object({
  type: z.literal('event_upload'),
  event_name: z.string().min(1).max(200),
  venue: z.string().max(200).optional(),
  event_date: z.string().optional(),
  description: z.string().max(1000).optional(),
  tags: z.string().max(300).optional(),
})

export type LocationPayload = z.infer<typeof LocationPayloadSchema>
export type FriendPayload = z.infer<typeof FriendPayloadSchema>
export type OnboardingPayload = z.infer<typeof OnboardingPayloadSchema>
export type MenuActionPayload = z.infer<typeof MenuActionPayloadSchema>
export type TripPlanPayload = z.infer<typeof TripPlanPayloadSchema>
export type EventPayload = z.infer<typeof EventPayloadSchema>
