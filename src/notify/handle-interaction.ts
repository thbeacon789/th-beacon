import { displayActor, parseButtonId, type IssueActor } from '@/core/lifecycle'
import { transformRoot, transitionIssue } from '@/pipeline/transition-issue'
import type { DiscordBot, InteractionResponder } from '@/notify/discord-bot'
import { verifyDiscordSignature } from '@/notify/discord-signature'
import type { DiscordMessage } from '@/notify/message'
import type { Store, StoredIssue } from '@/store/contracts'

export type InteractionResponse = { status: number; body: unknown; after?: () => Promise<void> }

interface InteractionPayload {
  type?: unknown
  token?: unknown
  data?: { custom_id?: unknown }
  member?: { user?: { id?: unknown } }
  user?: { id?: unknown }
  message?: { embeds?: unknown; components?: unknown }
}

const ephemeral = (content: string): InteractionResponse => ({
  status: 200,
  body: { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } },
})

/** 更新原訊息的 data：禁 mention，並移除 webhook 專用的 username（與 discord-bot 的 toBotBody 一致）。 */
function toInteractionData(m: DiscordMessage): Omit<DiscordMessage, 'username'> {
  const { username: _username, ...rest } = m
  return { ...rest, allowed_mentions: { parse: [] } }
}

export async function handleInteraction(
  store: Store,
  bot: DiscordBot | null,
  responder: InteractionResponder,
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
  // 非按鈕互動與無法解析的 custom_id 不碰 DB，同步回 ephemeral 即可（極快，不需 defer）
  if (interaction.type !== 3) return ephemeral('無法辨識的按鈕')

  const customId = interaction.data?.custom_id
  const parsed = typeof customId === 'string' ? parseButtonId(customId) : null
  const rawUserId = interaction.member?.user?.id ?? interaction.user?.id
  const userId = typeof rawUserId === 'string' && rawUserId !== '' ? rawUserId : null
  const token = typeof interaction.token === 'string' && interaction.token !== '' ? interaction.token : null
  if (parsed === null || userId === null) return ephemeral('無法辨識的按鈕')

  // 驗簽與解析後立即回 DEFERRED_UPDATE_MESSAGE（type 6），DB 與 Discord 呼叫全部移到 after，避開 3 秒限制
  const work = async (): Promise<void> => {
    let followUp: (() => Promise<void>) | undefined
    try {
      const outcome = await processClick(store, bot, interaction, parsed, userId, now)
      followUp = outcome.followUp
      if (token !== null) {
        if (outcome.kind === 'edit') await responder.editOriginal(token, outcome.data)
        else if (outcome.kind === 'ephemeral') await responder.followUp(token, outcome.content)
      }
    } catch (error) {
      console.error('discord interaction processing failed', error instanceof Error ? error.message : error)
      if (token !== null) await responder.followUp(token, '處理失敗，請稍後再試').catch(() => undefined)
    }
    if (followUp !== undefined) {
      try {
        await followUp()
      } catch (error) {
        console.error('discord interaction followUp failed', error instanceof Error ? error.message : error)
      }
    }
  }
  return { status: 200, body: { type: 6 }, after: work }
}

type Outcome =
  | { kind: 'edit'; data: unknown; followUp?: () => Promise<void> }
  | { kind: 'ephemeral'; content: string; followUp?: () => Promise<void> }
  | { kind: 'none'; followUp?: () => Promise<void> }

async function processClick(
  store: Store,
  bot: DiscordBot | null,
  interaction: InteractionPayload,
  parsed: NonNullable<ReturnType<typeof parseButtonId>>,
  userId: string,
  now: Date,
): Promise<Outcome> {
  const eph = (content: string): Outcome => ({ kind: 'ephemeral', content })

  const current = await store.getIssue(parsed.issueId)
  if (current === null) return eph('找不到此問題')
  if (current.reopenCount !== parsed.incidentSeq) return eph('此告警已過期，請看最新一則')

  const to = parsed.action === 'ack' ? 'acknowledged' : 'resolved'
  const actor = { kind: 'discord', userId } as const
  const result = await transitionIssue(store, bot, parsed.issueId, to, actor, now, {
    editRoot: false,
    deferFollowUp: true,
    expectedReopenCount: parsed.incidentSeq,
  })

  if (result.outcome === 'not_found' || result.issue === null) return eph('找不到此問題')

  if (result.outcome === 'unchanged') {
    // 預檢之後事故被 reopen：UPDATE 條件擋下，現況已是新事故
    if (result.issue.reopenCount !== parsed.incidentSeq) return eph('此告警已過期，請看最新一則')
    // 按到過時的按鈕（例如前一次點擊 DB 已更新但 Discord 畫面沒跟上）：
    // 直接把訊息重繪成現況，讓所有人看到誰已確認／已解決，並收掉過時按鈕。
    // 系統自動解決（resolvedBy 為 null）分不出輪詢或心跳，維持私訊提示。
    const synced = parsed.action === 'ack' || result.issue.resolvedBy !== null ? rebuildFromInteraction(interaction, result.issue) : null
    if (synced !== null) return { kind: 'edit', data: toInteractionData(synced) }
    if (parsed.action === 'ack') {
      const by = result.issue.acknowledgedBy
      return eph(by !== null ? `已由 ${displayActor(by)} 確認` : '已有人確認')
    }
    return eph('此問題已解決')
  }

  // changed
  const message: DiscordMessage | null =
    result.rootEdit !== null ? result.rootEdit.payload : rebuildFromInteraction(interaction, result.issue, actor)
  const followUp = result.followUp
  // 沒有可套用的訊息：不改畫面，DB 已更新
  return message !== null
    ? { kind: 'edit', data: toInteractionData(message), followUp }
    : { kind: 'none', followUp }
}

/** 以按鈕所在訊息為底，依 issue 現況重建；訊息沒有 embed 時回 null。 */
function rebuildFromInteraction(
  interaction: InteractionPayload,
  issue: StoredIssue,
  actor: IssueActor = { kind: 'discord', userId: '' },
): DiscordMessage | null {
  const m = interaction.message
  if (m === undefined || !Array.isArray(m.embeds) || m.embeds.length === 0) return null
  const base = {
    username: 'th-beacon',
    allowed_mentions: { parse: [] },
    embeds: m.embeds,
    ...(Array.isArray(m.components) ? { components: m.components } : {}),
  } as unknown as DiscordMessage
  return transformRoot(base, issue, actor)
}
