/**
 * Location Handler — processes Location Mini App submissions.
 * Receives structured location data from webapp/location-picker.html.
 */

import type { Logger } from 'pino'
import type { LocationPayload } from '../webapp-validators.js'
import { upsertSavedLocation } from '../../location.js'
import { saveUserLocation } from '../../character/index.js'
import { setLiveUserLocation } from '../../location-presence.js'
import { getOrCreateUser } from '../../character/session-store.js'
import { pendingLocationStore } from '../../location.js'

async function sendTgMessage(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true },
    }),
  }).catch(() => {})
}

export async function handleLocationSubmission(
  chatId: string,
  telegramUserId: string,
  payload: LocationPayload,
  log: Logger,
): Promise<void> {
  try {
    const user = await getOrCreateUser('telegram', telegramUserId)

    // Save to saved_locations table if user provided a label
    if (payload.action === 'save' && payload.label) {
      await upsertSavedLocation(user.userId, {
        label: payload.label,
        area: payload.area,
        lat: payload.lat,
        lng: payload.lng,
        is_default: payload.label.toLowerCase() === 'home',
      })
      log.info({ userId: telegramUserId, label: payload.label, area: payload.area }, 'Saved location upserted')
    }

    // Always update home_location on the users table
    await saveUserLocation(user.userId, payload.area)

    // Update live location for stimulus engine
    setLiveUserLocation(telegramUserId, {
      address: payload.area,
      lat: payload.lat,
      lng: payload.lng,
      source: 'gps',
    })

    // Re-trigger any pending location-dependent query
    const pending = pendingLocationStore.get(telegramUserId)
    if (pending) {
      pendingLocationStore.delete(telegramUserId)
      // Fire-and-forget: re-trigger the original query with the new location
      setImmediate(async () => {
        try {
          const { handleMessage } = await import('../../character/index.js')
          const originalQuery = pending.originalMessage ?? ''
          const retriggerMsg = originalQuery
            ? `${originalQuery.replace(/near\s+me/i, '').trim()} near ${payload.area}`
            : `near ${payload.area}`
          const response = await handleMessage('telegram', telegramUserId, retriggerMsg)
          if (response.text) {
            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: pending.chatId, text: response.text, parse_mode: 'HTML' }),
            }).catch(() => {})
          }
        } catch (err) {
          log.warn({ err }, 'Failed to re-trigger pending location query')
        }
      })
    }

    const labelMsg = payload.action === 'save' && payload.label ? ` Saved as <b>${payload.label}</b>.` : ''
    await sendTgMessage(chatId, `📍 Got it — <b>${payload.area}</b>!${labelMsg}`)
  } catch (err) {
    log.error({ err, telegramUserId }, 'Failed to handle location submission')
    await sendTgMessage(chatId, "Couldn't save that location. Try typing your area name instead.")
  }
}
