/**
 * Friend Handler — processes Friend Mini App submissions and native contact picker results.
 * Receives structured friend data from webapp/friend-selector.html.
 */

import type { Logger } from 'pino'
import type { FriendPayload } from '../webapp-validators.js'
import { addFriend } from '../../social/friend-graph.js'
import { getOrCreateUser, getPool } from '../../character/session-store.js'

async function sendTgMessage(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  }).catch(() => {})
}

/**
 * Handle friend_select Mini App submission.
 * Adds each UUID in payload.friends as a friend of the submitting user.
 */
export async function handleFriendSubmission(
  chatId: string,
  telegramUserId: string,
  payload: FriendPayload,
  log: Logger,
): Promise<void> {
  try {
    const user = await getOrCreateUser('telegram', telegramUserId)
    const pool = getPool()

    let added = 0
    for (const friendUuid of payload.friends) {
      // Verify the UUID exists in users table before adding
      const { rows } = await pool.query<{ user_id: string }>(
        'SELECT user_id FROM users WHERE user_id = $1 LIMIT 1',
        [friendUuid]
      )
      if (!rows.length) continue

      await addFriend(user.userId, friendUuid).catch(() => {})
      added++
    }

    log.info({ userId: telegramUserId, requested: payload.friends.length, added }, 'Friend(s) added via Mini App')

    if (added > 0) {
      await sendTgMessage(chatId, `Added ${added} friend${added === 1 ? '' : 's'}! 🤝 They'll show up in your squad suggestions now.`)
    } else {
      await sendTgMessage(chatId, "Couldn't find those users on Aria yet — they may not have joined.")
    }
  } catch (err) {
    log.error({ err, telegramUserId }, 'Failed to handle friend submission')
    await sendTgMessage(chatId, "Something went wrong adding friends. Try again?")
  }
}

/**
 * Handle users_shared result from KeyboardButtonRequestUsers.
 * Attempts to match Telegram user IDs to existing Aria users and adds them as friends.
 */
export async function handleUsersShared(
  chatId: string,
  telegramUserId: string,
  sharedTelegramIds: string[],
  log: Logger,
): Promise<void> {
  try {
    const user = await getOrCreateUser('telegram', telegramUserId)
    const pool = getPool()

    let added = 0
    for (const tgId of sharedTelegramIds) {
      const { rows } = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM users WHERE channel = 'telegram' AND channel_user_id = $1 LIMIT 1`,
        [tgId]
      )
      if (!rows.length) continue
      await addFriend(user.userId, rows[0].user_id).catch(() => {})
      await addFriend(rows[0].user_id, user.userId).catch(() => {})
      added++
    }

    log.info({ userId: telegramUserId, shared: sharedTelegramIds.length, added }, 'Users shared processed')

    if (added > 0) {
      await sendTgMessage(chatId, `Connected with ${added} friend${added === 1 ? '' : 's'} on Aria! 🤝`)
    } else {
      await sendTgMessage(chatId, "None of those contacts are on Aria yet — share your invite link to bring them in!")
    }
  } catch (err) {
    log.error({ err, telegramUserId }, 'Failed to handle users_shared')
  }
}
