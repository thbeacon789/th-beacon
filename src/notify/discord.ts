import type { DiscordMessage } from '@/notify/message'

export type SendResult = { ok: true } | { ok: false; reason: string }
export type DiscordSender = (webhookUrl: string, message: DiscordMessage) => Promise<SendResult>

const SEND_TIMEOUT_MS = 5000

export const sendDiscordWebhook: DiscordSender = async (webhookUrl, message) => {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    // 消費 body：釋放連線，並保留未來讀 rate-limit 資訊的空間
    await response.arrayBuffer().catch(() => undefined)
    if (response.status >= 200 && response.status < 300) return { ok: true }
    return { ok: false, reason: `http ${response.status}` }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : 'fetch_failed' }
  }
}
