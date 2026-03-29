/**
 * Trip Handler — processes trip_plan Mini App submissions.
 * Saves the trip as an agenda goal and routes through Aria's pipeline
 * so she acknowledges it in character and offers to start planning.
 */

import type { Logger } from 'pino'
import type { TripPlanPayload } from '../webapp-validators.js'
import { getPool, getOrCreateUser } from '../../character/session-store.js'
import { handleMessage } from '../../character/handler.js'

export async function handleTripPlanSubmission(
  chatId: string,
  userId: string,
  payload: TripPlanPayload,
  log: Logger,
): Promise<void> {
  log.info({ userId, destination: payload.destination }, 'Trip plan Mini App submission')

  try {
    const user = await getOrCreateUser('telegram', userId)
    const pool = getPool()

    // Build a human-readable description for the agenda goal
    const parts: string[] = [`Trip to ${payload.destination}`]
    if (payload.origin) parts.push(`from ${payload.origin}`)
    if (payload.departure_date) parts.push(`departing ${payload.departure_date}`)
    if (payload.return_date) parts.push(`returning ${payload.return_date}`)
    if (payload.travelers > 1) parts.push(`${payload.travelers} travelers`)
    if (payload.interests.length) parts.push(`interests: ${payload.interests.join(', ')}`)
    const description = parts.join(', ')

    // Persist to agenda_goals so Aria has context across sessions
    await pool.query(
      `INSERT INTO agenda_goals (user_id, goal_text, status, source, created_at, updated_at)
       VALUES ($1, $2, 'active', 'trip_planner', NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [user.userId, description]
    ).catch(() => {
      // agenda_goals schema may differ — log and continue
      log.warn({ userId }, 'Could not save trip to agenda_goals — continuing anyway')
    })

    // Build a context message that routes through the full Aria pipeline
    const budgetLabel = payload.budget === 'budget' ? 'budget-friendly' : payload.budget === 'premium' ? 'premium' : 'mid-range'
    const contextMsg = [
      `[trip_planner] User submitted a trip plan via Mini App.`,
      `Destination: ${payload.destination}`,
      payload.origin ? `Origin: ${payload.origin}` : '',
      payload.departure_date ? `Departure: ${payload.departure_date}` : '',
      payload.return_date ? `Return: ${payload.return_date}` : '',
      `Travelers: ${payload.travelers}`,
      `Budget: ${budgetLabel}`,
      payload.interests.length ? `Interests: ${payload.interests.join(', ')}` : '',
      `Acknowledge the trip plan enthusiastically, confirm the key details, and ask what to tackle first — flights, hotels, or things to do.`,
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
    log.error({ err, userId }, 'Trip plan handler failed')
  }
}
