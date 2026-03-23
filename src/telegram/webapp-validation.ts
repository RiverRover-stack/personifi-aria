/**
 * Telegram Mini App initData HMAC-SHA256 validation.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { WebAppInitData } from './types.js'

const MAX_AUTH_AGE_SECONDS = 86400 // 24 hours

/**
 * Validate the initData string sent by Telegram Mini Apps.
 *
 * Algorithm:
 * 1. Parse as URLSearchParams
 * 2. Extract `hash` field
 * 3. Sort remaining key=value pairs alphabetically, join with \n → dataCheckString
 * 4. secretKey = HMAC-SHA256("WebAppData", botToken)
 * 5. expectedHash = HMAC-SHA256(dataCheckString, secretKey).hex
 * 6. timingSafeEqual(expectedHash, hash)
 * 7. Validate auth_date is within 24 hours
 */
export function validateInitData(
  initDataString: string,
  botToken: string,
): { valid: boolean; data?: WebAppInitData } {
  if (!initDataString || !botToken) return { valid: false }

  try {
    const params = new URLSearchParams(initDataString)
    const receivedHash = params.get('hash')
    if (!receivedHash) return { valid: false }

    // Build data-check string: sorted key=value pairs (excluding hash), joined by \n
    const entries: string[] = []
    for (const [key, value] of params.entries()) {
      if (key !== 'hash') entries.push(`${key}=${value}`)
    }
    entries.sort()
    const dataCheckString = entries.join('\n')

    // Derive secret key: HMAC-SHA256(botToken, "WebAppData")
    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest()

    // Compute expected hash
    const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

    // Timing-safe comparison
    const expectedBuf = Buffer.from(expectedHash, 'utf8')
    const receivedBuf = Buffer.from(receivedHash, 'utf8')
    if (expectedBuf.length !== receivedBuf.length) return { valid: false }
    if (!timingSafeEqual(expectedBuf, receivedBuf)) return { valid: false }

    // Validate auth_date freshness
    const authDateStr = params.get('auth_date')
    if (!authDateStr) return { valid: false }
    const authDate = parseInt(authDateStr, 10)
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (nowSeconds - authDate > MAX_AUTH_AGE_SECONDS) return { valid: false }

    // Parse user if present
    let user: WebAppInitData['user'] | undefined
    const userStr = params.get('user')
    if (userStr) {
      try {
        user = JSON.parse(userStr)
      } catch {
        // user field is optional
      }
    }

    return {
      valid: true,
      data: {
        query_id: params.get('query_id') ?? undefined,
        user,
        auth_date: authDate,
        hash: receivedHash,
        start_param: params.get('start_param') ?? undefined,
        chat_type: params.get('chat_type') ?? undefined,
        chat_instance: params.get('chat_instance') ?? undefined,
      },
    }
  } catch {
    return { valid: false }
  }
}
