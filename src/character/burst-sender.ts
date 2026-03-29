/**
 * Burst Sender — splits responses into 2-3 messages with typing delays,
 * mimicking how a real person texts.
 */

export interface BurstMessage {
    text: string
    typingDelayMs: number
    mediaUrl?: string
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function sendTypingAction(chatId: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    }).catch(() => {})
}

async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
    }).catch(() => {})
}

/**
 * Send a burst of messages with typing indicators between each.
 */
export async function sendBurst(chatId: string, messages: BurstMessage[]): Promise<void> {
    for (const msg of messages) {
        const delay = Math.min(1500, Math.max(400, msg.typingDelayMs))
        await sendTypingAction(chatId)
        await sleep(delay)
        await sendTelegramMessage(chatId, msg.text)
    }
}

/**
 * Split a response text into 2-3 burst messages.
 *
 * Rules:
 * 1. Greeting clause separated by \n\n → first message = greeting, second = body
 * 2. Response contains a question AND a statement → split before the question
 * 3. Proactive messages: always at least 2 parts
 * 4. Reactive responses under 80 words: single message
 * 5. Maximum 3 parts
 */
export function splitIntoMessages(text: string, context: 'proactive' | 'reactive'): BurstMessage[] {
    const wordCount = text.trim().split(/\s+/).length

    // Short reactive responses: don't split
    if (context === 'reactive' && wordCount < 80) {
        return [{ text, typingDelayMs: Math.min(1500, Math.max(400, text.length * 8)) }]
    }

    const parts: string[] = []

    // Rule 1: natural paragraph break
    const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
    if (paragraphs.length >= 2) {
        // First paragraph as opener, rest as body
        parts.push(paragraphs[0])
        parts.push(paragraphs.slice(1).join('\n\n'))
    } else {
        // Rule 2: split before a question sentence
        const sentences = text.split(/(?<=[.!?])\s+/)
        const questionIdx = sentences.findIndex(s => s.includes('?'))
        if (questionIdx > 0 && questionIdx < sentences.length - 1) {
            parts.push(sentences.slice(0, questionIdx).join(' '))
            parts.push(sentences.slice(questionIdx).join(' '))
        } else {
            parts.push(text)
        }
    }

    // Rule 3: proactive always gets at least 2 parts
    if (context === 'proactive' && parts.length === 1) {
        parts.unshift('Hey!')
    }

    // Cap at 3 parts
    const finalParts = parts.slice(0, 3).filter(p => p.trim().length > 0)

    return finalParts.map(p => ({
        text: p.trim(),
        typingDelayMs: Math.min(1500, Math.max(400, p.length * 8)),
    }))
}
