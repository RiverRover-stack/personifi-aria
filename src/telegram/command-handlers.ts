/**
 * Command Handlers — handles Telegram slash commands.
 * /settings, /friends, /locations, /trip, /help
 */

import { getPool } from '../character/session-store.js'
import { getFriends, getPendingRequests } from '../social/friend-graph.js'

export interface CommandResponse {
  text: string
  keyboard?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> }
  webAppButton?: {
    url: string
    buttonText: string
  }
}

/**
 * Route a slash command to its handler.
 * Returns null for unknown commands (caller falls through to handleMessage).
 */
export async function handleCommand(
  commandText: string,
  internalUserId: string,
  _telegramUserId: string,
): Promise<CommandResponse | null> {
  const cmd = commandText.trim().split(/\s+/)[0].toLowerCase().replace(/^\//, '')

  switch (cmd) {
    case 'start': return null  // handled by onboarding flow
    case 'settings': return await getSettingsResponse(internalUserId)
    case 'friends': return await getFriendsResponse(internalUserId)
    case 'locations': return getLocationsResponse()
    case 'trip': return getTripResponse()
    case 'help': return getHelpResponse()
    default: return null
  }
}

async function getSettingsResponse(userId: string): Promise<CommandResponse> {
  const pool = getPool()
  const { rows } = await pool.query<{ category: string; value: string }>(
    `SELECT category, value FROM user_preferences WHERE user_id = $1 ORDER BY category`,
    [userId]
  )
  if (!rows.length) {
    return {
      text: "You haven't set any preferences yet! Complete setup with /start",
      keyboard: {
        inline_keyboard: [[{ text: '🚀 Set Up Now', callback_data: 'start_onboarding' }]],
      },
    }
  }

  const categoryLabels: Record<string, string> = {
    dietary: '🍕 Food',
    budget: '💰 Budget',
    travel_style: '✈️ Travel',
    entertainment: '🎬 Entertainment',
    time_preference: '⏰ Time',
    dietary_restriction: '🥗 Dietary',
    commute: '🚗 Commute',
    communication: '📱 Comms',
  }
  const prefLines = rows
    .map(r => `${categoryLabels[r.category] ?? r.category}: <b>${r.value}</b>`)
    .join('\n')

  return {
    text: `⚙️ <b>Your Preferences</b>\n\n${prefLines}`,
    keyboard: {
      inline_keyboard: [
        [
          { text: '🍕 Food', callback_data: 'edit_pref_dietary' },
          { text: '💰 Budget', callback_data: 'edit_pref_budget' },
          { text: '✈️ Travel', callback_data: 'edit_pref_travel' },
        ],
        [
          { text: '🎬 Entertainment', callback_data: 'edit_pref_entertainment' },
          { text: '⏰ Time', callback_data: 'edit_pref_time' },
        ],
        [
          { text: '🥗 Dietary', callback_data: 'edit_pref_dietary_restriction' },
          { text: '🚗 Commute', callback_data: 'edit_pref_commute' },
          { text: '📱 Comms', callback_data: 'edit_pref_comms' },
        ],
      ],
    },
  }
}

async function getFriendsResponse(userId: string): Promise<CommandResponse> {
  const baseUrl = process.env.WEBAPP_BASE_URL

  const [friends, pending] = await Promise.all([
    getFriends(userId).catch(() => []),
    getPendingRequests(userId).catch(() => []),
  ])

  const lines: string[] = ['👥 <b>Your Friends</b>\n']

  if (friends.length === 0 && pending.length === 0) {
    lines.push("You haven't added any friends yet.")
  } else {
    if (friends.length > 0) {
      lines.push(...friends.map(f => `• ${f.displayName ?? f.alias ?? 'Unknown'}`))
    }
    if (pending.length > 0) {
      lines.push(`\n⏳ <b>Pending requests</b>`)
      lines.push(...pending.map(p => `• ${p.displayName ?? 'Unknown'} <i>(tap to accept)</i>`))
    }
  }

  const keyboard: CommandResponse['keyboard'] = {
    inline_keyboard: [
      ...(pending.map(p => ([{
        text: `✅ Accept ${p.displayName ?? 'request'}`,
        callback_data: `friend:accept:${p.friendId ?? p.userId}`,
      }]))),
      baseUrl ? [] : [],
    ].filter(row => row.length > 0),
  }

  if (baseUrl) {
    return {
      text: lines.join('\n'),
      webAppButton: {
        url: `${baseUrl}/webapp/friend-selector.html`,
        buttonText: '➕ Add Friends',
      },
    }
  }

  return {
    text: lines.join('\n'),
    keyboard: {
      inline_keyboard: keyboard.inline_keyboard.length > 0 ? keyboard.inline_keyboard : [[{ text: '➕ Add a friend — share their Telegram username', callback_data: 'noop' }]],
    },
  }
}

function getLocationsResponse(): CommandResponse {
  const baseUrl = process.env.WEBAPP_BASE_URL
  if (!baseUrl) {
    return { text: 'Share your location or type your area name and I\'ll save it!' }
  }
  return {
    text: 'Manage your saved locations 📍',
    webAppButton: {
      url: `${baseUrl}/webapp/location-picker.html`,
      buttonText: '📍 Open Locations',
    },
  }
}

function getTripResponse(): CommandResponse {
  const baseUrl = process.env.WEBAPP_BASE_URL
  if (!baseUrl) {
    return { text: "Just tell me where you want to go and I'll plan it with you! ✈️" }
  }
  return {
    text: '🗺️ <b>Plan a Trip</b>\nPick your destination, dates, and vibe — I\'ll handle the rest.',
    webAppButton: {
      url: `${baseUrl}/webapp/trip-planner.html`,
      buttonText: '✈️ Plan a Trip',
    },
  }
}

function getHelpResponse(): CommandResponse {
  return {
    text: `❓ <b>What can Aria do?</b>

🔮 <b>Proactive</b> — I text you first when something relevant happens
📍 <b>Locations</b> — Save home, office, favourite spots
👥 <b>Friends</b> — Group suggestions, squad plans
🌤️ <b>Weather</b> — Smart commute + travel alerts
🍽️ <b>Food</b> — Best bites near you, delivery deals
✈️ <b>Travel</b> — Flights, stays, hidden gems
💰 <b>Prices</b> — Cab surge alerts, grocery deals

<b>Commands:</b>
/settings — View & edit your preferences
/friends — Manage your friend circle
/locations — Saved locations
/trip — Plan a trip
/help — This message`,
    keyboard: {
      inline_keyboard: [
        [
          { text: '⚙️ Settings', callback_data: 'run_settings' },
          { text: '👥 Friends', callback_data: 'run_friends' },
        ],
      ],
    },
  }
}
