/**
 * Webapp Router — parses, validates, and routes web_app_data submissions
 * from Telegram Mini Apps to the appropriate handler.
 */

import type { Logger } from 'pino'
import {
  LocationPayloadSchema,
  FriendPayloadSchema,
  OnboardingPayloadSchema,
  MenuActionPayloadSchema,
} from './webapp-validators.js'

const MAX_PAYLOAD_BYTES = 4096

export async function handleWebAppData(
  chatId: string,
  userId: string,
  rawData: string,
  log: Logger,
): Promise<void> {
  // Guard: Telegram's stated max is 4096 bytes
  if (Buffer.byteLength(rawData, 'utf8') > MAX_PAYLOAD_BYTES) {
    log.warn({ userId, size: Buffer.byteLength(rawData, 'utf8') }, 'Mini App payload exceeds 4096 bytes — rejected')
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawData)
  } catch {
    log.warn({ userId, preview: rawData.slice(0, 100) }, 'Mini App payload is not valid JSON')
    return
  }

  const type = (parsed as Record<string, unknown>)?.type
  log.info({ userId, type }, 'Mini App data received')

  if (type === 'location') {
    const result = LocationPayloadSchema.safeParse(parsed)
    if (!result.success) {
      log.warn({ userId, errors: result.error.issues }, 'Location payload validation failed')
      return
    }
    const { handleLocationSubmission } = await import('./handlers/location-handler.js')
    await handleLocationSubmission(chatId, userId, result.data, log)

  } else if (type === 'friend_select') {
    const result = FriendPayloadSchema.safeParse(parsed)
    if (!result.success) {
      log.warn({ userId, errors: result.error.issues }, 'Friend payload validation failed')
      return
    }
    const { handleFriendSubmission } = await import('./handlers/friend-handler.js')
    await handleFriendSubmission(chatId, userId, result.data, log)

  } else if (type === 'onboarding') {
    const result = OnboardingPayloadSchema.safeParse(parsed)
    if (!result.success) {
      log.warn({ userId, errors: result.error.issues }, 'Onboarding payload validation failed')
      return
    }
    // Onboarding via Mini App is handled by the standard onboarding flow
    log.info({ userId, prefs: Object.keys(result.data.preferences) }, 'Onboarding Mini App submission received')

  } else if (type === 'menu_action') {
    const result = MenuActionPayloadSchema.safeParse(parsed)
    if (!result.success) {
      log.warn({ userId, errors: result.error.issues }, 'Menu action payload validation failed')
      return
    }
    // Menu actions that look like commands get routed to the command handler
    const action = result.data.action
    if (action === 'request_contacts') {
      // Send a ReplyKeyboard with KeyboardButtonRequestUsers so the user can share contacts
      const token = process.env.TELEGRAM_BOT_TOKEN
      if (token) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '👥 Tap the button below to share contacts with Aria:',
            reply_markup: {
              keyboard: [[{ text: '📱 Share contacts', request_users: { request_id: 1, user_is_bot: false } }]],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          }),
        }).catch(() => {})
      }
    } else if (action.startsWith('/')) {
      const { getOrCreateUser } = await import('../character/session-store.js')
      const user = await getOrCreateUser('telegram', userId)
      const { handleCommand } = await import('./command-handlers.js')
      const cmdResponse = await handleCommand(action, user.userId, userId)
      if (cmdResponse) {
        await sendTgMessage(chatId, cmdResponse.text)
      }
    }

  } else {
    log.warn({ userId, type }, 'Unknown Mini App payload type — ignoring')
  }
}

async function sendTgMessage(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => {})
}
