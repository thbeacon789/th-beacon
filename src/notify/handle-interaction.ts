import { displayActor, parseButtonId } from '@/core/lifecycle'
import { transformRoot, transitionIssue } from '@/pipeline/transition-issue'
import type { DiscordBot } from '@/notify/discord-bot'
import { verifyDiscordSignature } from '@/notify/discord-signature'
import type { DiscordMessage } from '@/notify/message'
import type { Store } from '@/store/contracts'

export type InteractionResponse = { status: number; body: unknown; after?: () => Promise<void> }

interface InteractionPayload {
  type?: unknown
  data?: { custom_id?: unknown }
  member?: { user?: { id?: unknown } }
  user?: { id?: unknown }
  message?: { embeds?: unknown; components?: unknown }
}

const ephemeral = (content: string): InteractionResponse => ({
  status: 200,
  body: { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } },
})

/** type 7 的 data：禁 mention，並移除 webhook 專用的 username（與 discord-bot 的 toBotBody 一致）。 */
function toInteractionData(m: DiscordMessage): Omit<DiscordMessage, 'username'> {
  const { username: _username, ...rest } = m
  return { ...rest, allowed_mentions: { parse: [] } }
}

export async function handleInteraction(
  store: Store,
  bot: DiscordBot | null,
  config: { publicKey: string },
  request: { rawBody: string; signature: string | null; timestamp: string | null },
  now: Date,
): Promise<InteractionResponse> {
  const { rawBody, signature, timestamp } = request
  if (
    signature === null ||
    timestamp === null ||
    !verifyDiscordSignature(config.publicKey, signature, timestamp, rawBody)
  ) {
    return { status: 401, body: { error: 'invalid request signature' } }
  }

  let interaction: InteractionPayload
  try {
    interaction = JSON.parse(rawBody) as InteractionPayload
  } catch {
    return { status: 400, body: { error: 'invalid json' } }
  }

  if (interaction.type === 1) return { status: 200, body: { type: 1 } }
  if (interaction.type !== 3) return ephemeral('無法辨識的按鈕')

  const customId = interaction.data?.custom_id
  const parsed = typeof customId === 'string' ? parseButtonId(customId) : null
  const rawUserId = interaction.member?.user?.id ?? interaction.user?.id
  const userId = typeof rawUserId === 'string' && rawUserId !== '' ? rawUserId : null
  if (parsed === null || userId === null) return ephemeral('無法辨識的按鈕')

  const current = await store.getIssue(parsed.issueId)
  if (current === null) return ephemeral('找不到此問題')
  if (current.reopenCount !== parsed.incidentSeq) return ephemeral('此告警已過期，請看最新一則')

  const to = parsed.action === 'ack' ? 'acknowledged' : 'resolved'
  const actor = { kind: 'discord', userId } as const
  const result = await transitionIssue(store, bot, parsed.issueId, to, actor, now, {
    editRoot: false,
    deferFollowUp: true,
    expectedReopenCount: parsed.incidentSeq,
  })

  if (result.outcome === 'not_found' || result.issue === null) return ephemeral('找不到此問題')

  if (result.outcome === 'unchanged') {
    // 預檢之後事故被 reopen：UPDATE 條件擋下，現況已是新事故
    if (result.issue.reopenCount !== parsed.incidentSeq) return ephemeral('此告警已過期，請看最新一則')
    if (parsed.action === 'ack') {
      const by = result.issue.acknowledgedBy
      return ephemeral(by !== null ? `已由 ${displayActor(by)} 確認` : '已有人確認')
    }
    return ephemeral('此問題已解決')
  }

  // changed
  let message: DiscordMessage | null = null
  if (result.rootEdit !== null) {
    message = result.rootEdit.payload
  } else {
    const m = interaction.message
    if (m !== undefined && Array.isArray(m.embeds) && m.embeds.length > 0) {
      const base = {
        username: 'th-beacon',
        allowed_mentions: { parse: [] },
        embeds: m.embeds,
        ...(Array.isArray(m.components) ? { components: m.components } : {}),
      } as unknown as DiscordMessage
      message = transformRoot(base, result.issue, actor)
    }
  }

  const body =
    message !== null
      ? { type: 7, data: toInteractionData(message) }
      : { type: 6 } // 沒有可套用的訊息：不改畫面，DB 已更新
  return { status: 200, body, after: result.followUp }
}
