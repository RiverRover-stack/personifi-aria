/**
 * Bot Setup — registers bot commands and menu button on startup.
 * Called once after the Fastify server starts listening.
 */

import { logger } from '../logger.js'

const log = logger.child({ module: 'bot-setup' })

type TgFetch = (method: string, body: object) => Promise<unknown>

const BOT_COMMANDS = [
  { command: 'start', description: 'Start Aria / restart onboarding' },
  { command: 'settings', description: 'Your preferences & saved locations' },
  { command: 'friends', description: 'Manage your friend circle' },
  { command: 'locations', description: 'Your saved locations' },
  { command: 'trip', description: 'Plan a trip with friends' },
  { command: 'help', description: 'What can Aria do?' },
]

/**
 * Register bot slash-commands so they appear in the Telegram command picker.
 * Calls setMyCommands — runs once at startup, fire-and-forget safe.
 */
export async function registerBotCommands(tgFetch: TgFetch): Promise<void> {
  try {
    await tgFetch('setMyCommands', { commands: BOT_COMMANDS })
    log.info({ count: BOT_COMMANDS.length }, 'Bot commands registered')
  } catch (err) {
    log.warn({ err }, 'Failed to register bot commands — will retry on next restart')
  }
}

/**
 * Set the persistent menu button in the chat header.
 * Opens the menu Mini App (webapp/menu.html) when tapped.
 */
export async function setupMenuButton(tgFetch: TgFetch, baseUrl: string): Promise<void> {
  try {
    await tgFetch('setChatMenuButton', {
      menu_button: {
        type: 'web_app',
        text: 'Aria Menu',
        web_app: { url: `${baseUrl}/webapp/menu.html` },
      },
    })
    log.info({ baseUrl }, 'Menu button configured')
  } catch (err) {
    log.warn({ err }, 'Failed to set menu button — will retry on next restart')
  }
}
