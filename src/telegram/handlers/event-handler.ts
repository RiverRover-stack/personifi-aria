/**
 * Event Handler — processes event_upload Mini App submissions.
 * Saves the event as a conversation plan and routes through Aria's pipeline.
 */

import type { Logger } from 'pino'
import type { EventPayload } from '../webapp-validators.js'
import { getPool, getOrCreateUser } from '../../character/session-store.js'
import { handleMessage } from '../../character/handler.js'

export async function handleEventSubmission(
  chatId: string,
  userId: string,
  payload: EventPayload,
  log: Logger,
): Promise<void> {
  log.info({ userId, event: payload.event_name }, 'Event upload Mini App submission')

  try {
    const user = await getOrCreateUser('telegram', userId)
    const pool = getPool()

    // Persist to conversation_plans so Sentinel can fire a reminder
    const scheduledFor = payload.event_date
      ? new Date(payload.event_date).toISOString().split('T')[0]
      : null

    await pool.query(
      `INSERT INTO conversation_plans
         (user_id, session_id, plan_type, description, scheduled_for, status, expires_at, created_at, updated_at)
       VALUES ($1, 'webapp', 'event', $2, $3, 'pending', NOW() + INTERVAL '7 days', NOW(), NOW())`,
      [
        user.userId,
        [
          payload.event_name,
          payload.venue ? `at ${payload.venue}` : '',
          payload.description ?? '',
        ].filter(Boolean).join(' — '),
        scheduledFor,
      ]
    ).catch(() => {
      log.warn({ userId }, 'Could not save event to conversation_plans — continuing anyway')
    })

    // Route through Aria pipeline for natural acknowledgement
    const contextMsg = [
      `[event_upload] User added an event via Mini App.`,
      `Event: ${payload.event_name}`,
      payload.venue ? `Venue: ${payload.venue}` : '',
      payload.event_date ? `Date: ${payload.event_date}` : '',
      payload.description ? `Details: ${payload.description}` : '',
      payload.tags ? `Tags: ${payload.tags}` : '',
      `Acknowledge the event, confirm the details, and offer something useful — directions, what to wear, nearby food spots, or a reminder closer to the date.`,
    ].filter(Boolean).join('\n')

    const response = await handleMessage('telegram', userId, contextMsg)

    if (response?.text) {
      const token = process.env.TELEGRAM_BOT_TOKEN
      if (token) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: response.text, parse_mode: 'HTML' }),
        }).catch(() => {})
      }
    }
  } catch (err) {
    log.error({ err, userId }, 'Event handler failed')
  }
}
