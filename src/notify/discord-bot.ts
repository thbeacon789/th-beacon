import type { SendResult } from '@/notify/discord'
import type { DiscordOutgoing } from '@/notify/message'

export type BotPostResult = { ok: true; channelId: string; messageId: string } | { ok: false; reason: string }

export interface DiscordBot {
  post(message: DiscordOutgoing): Promise<BotPostResult>
  edit(channelId: string, messageId: string, message: DiscordOutgoing): Promise<SendResult>
}

const API_BASE = 'https://discord.com/api/v10'
const SEND_TIMEOUT_MS = 5000

/** username 是 webhook 專用欄位，Bot 端點不認，送出前移除 */
function toBotBody(message: DiscordOutgoing): string {
  const { username: _username, ...rest } = message as DiscordOutgoing & { username?: string }
  return JSON.stringify(rest)
}

export function createDiscordBot(
  config: { token: string; channelId: string },
  fetchImpl: typeof fetch = fetch,
): DiscordBot {
  const request = async (method: 'POST' | 'PATCH', url: string, message: DiscordOutgoing): Promise<Response> =>
    fetchImpl(url, {
      method,
      headers: { Authorization: `Bot ${config.token}`, 'content-type': 'application/json' },
      body: toBotBody(message),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  const isOk = (response: Response): boolean => response.status >= 200 && response.status < 300

  return {
    async post(message) {
      try {
        const response = await request('POST', `${API_BASE}/channels/${config.channelId}/messages`, message)
        if (!isOk(response)) {
          await response.arrayBuffer().catch(() => undefined)
          return { ok: false, reason: `http ${response.status}` }
        }
        const json = (await response.json().catch(() => null)) as { id?: unknown } | null
        if (typeof json?.id !== 'string') return { ok: false, reason: 'bad_response' }
        return { ok: true, channelId: config.channelId, messageId: json.id }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.name : 'fetch_failed' }
      }
    },
    async edit(channelId, messageId, message) {
      try {
        const response = await request('PATCH', `${API_BASE}/channels/${channelId}/messages/${messageId}`, message)
        await response.arrayBuffer().catch(() => undefined)
        return isOk(response) ? { ok: true } : { ok: false, reason: `http ${response.status}` }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.name : 'fetch_failed' }
      }
    },
  }
}

/** 互動回應用的 webhook 端點（以 interaction token 驗證，免 bot Authorization，token 有效 15 分鐘）。不 throw。 */
export interface InteractionResponder {
  /** PATCH @original：把 deferred 的原訊息更新成 data */
  editOriginal(token: string, data: unknown): Promise<SendResult>
  /** 發 ephemeral follow-up（只有點擊者看得到） */
  followUp(token: string, content: string): Promise<SendResult>
}

export function createInteractionResponder(
  config: { applicationId: string },
  fetchImpl: typeof fetch = fetch,
): InteractionResponder {
  const base = `${API_BASE}/webhooks/${config.applicationId}`
  const send = async (method: 'POST' | 'PATCH', url: string, body: unknown): Promise<SendResult> => {
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      await response.arrayBuffer().catch(() => undefined)
      if (response.status >= 200 && response.status < 300) return { ok: true }
      console.error(`discord interaction ${method} failed: http ${response.status}`)
      return { ok: false, reason: `http ${response.status}` }
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'fetch_failed'
      console.error(`discord interaction ${method} failed: ${reason}`)
      return { ok: false, reason }
    }
  }
  return {
    editOriginal: (token, data) => send('PATCH', `${base}/${token}/messages/@original`, data),
    followUp: (token, content) =>
      send('POST', `${base}/${token}`, { content, flags: 64, allowed_mentions: { parse: [] } }),
  }
}
