import { displayActor, encodeButtonId, type ButtonAction } from '@/core/lifecycle'
import type { StoredIssue } from '@/store/contracts'
import { formatAlertTime, LAST_SEEN_FIELD, type DiscordEmbedField, type DiscordMessage, type DiscordReplyMessage } from './message'

const GREEN = 0x2ecc71
const GREY = 0x95a5a6

type Source = 'manual' | 'poll' | 'heartbeat'

const REOPENED_FIELD = '↻ Reopened'
const AUTO_SOURCE: Record<Exclude<Source, 'manual'>, string> = { poll: '輪詢', heartbeat: '心跳' }

const SEVERITY_MARK_RE = /^(?:🔴|🟠|🔵) /u

/** 狀態前綴取代標題開頭的嚴重度色塊，避免兩個色塊並列。 */
function prefixTitle(title: string, prefix: string): string {
  if (title.startsWith(`${prefix} `)) return title
  return `${prefix} ${title.replace(SEVERITY_MARK_RE, '')}`
}

function upsertField(fields: DiscordEmbedField[], field: DiscordEmbedField): void {
  const i = fields.findIndex((f) => f.name === field.name)
  if (i >= 0) fields[i] = field
  else fields.push(field)
}

/** 編輯類輸出共用：去 content、禁止所有 mention。 */
function stripMentions(m: DiscordMessage): void {
  delete m.content
  m.allowed_mentions = { parse: [] }
}

function buttonRow(issueId: string, incidentSeq: number, actions: readonly ButtonAction[]) {
  const all = {
    ack: { type: 2 as const, style: 2 as const, label: 'Acknowledge' },
    resolve: { type: 2 as const, style: 3 as const, label: 'Resolve' },
  }
  return {
    type: 1 as const,
    components: actions.map((a) => ({
      ...all[a],
      custom_id: encodeButtonId(a, issueId, incidentSeq),
    })),
  }
}

export function withAlertButtons(
  msg: DiscordMessage,
  issueId: string,
  incidentSeq: number,
  actions: readonly ButtonAction[],
): DiscordMessage {
  const m = structuredClone(msg)
  m.components = [buttonRow(issueId, incidentSeq, actions)]
  return m
}

/** 只移除按鈕，內容（embed／欄位／顏色）完全不動。 */
export function withoutButtons(msg: DiscordMessage): DiscordMessage {
  const m = structuredClone(msg)
  stripMentions(m)
  delete m.components
  return m
}

export function applyIgnored(msg: DiscordMessage): DiscordMessage {
  const m = structuredClone(msg)
  stripMentions(m)
  delete m.components
  m.embeds[0].color = GREY
  m.embeds[0].title = prefixTitle(m.embeds[0].title, '⚪ Ignored')
  return m
}

export function applyReopened(msg: DiscordMessage, reopenCount: number): DiscordMessage {
  const m = structuredClone(msg)
  stripMentions(m)
  delete m.components
  upsertField(m.embeds[0].fields, {
    name: REOPENED_FIELD,
    value: `第 ${reopenCount} 次，見最新回覆`,
    inline: false,
  })
  return m
}

export function applyCount(msg: DiscordMessage, count: number, lastSeen: string): DiscordMessage {
  const m = structuredClone(msg)
  for (const f of m.embeds[0].fields) {
    if (f.name === '次數') f.value = String(count)
    // 'Last seen' 為改版前的欄位名，舊根訊息仍要能更新
    else if (f.name === LAST_SEEN_FIELD || f.name === 'Last seen') f.value = formatAlertTime(lastSeen)
  }
  return m
}

/** replyToMessageId 省略＝不帶 message_reference（討論串內發送） */
function reply(content: string, replyToMessageId?: string): DiscordReplyMessage {
  const m: DiscordReplyMessage = { username: 'th-beacon', content, allowed_mentions: { parse: [] } }
  if (replyToMessageId !== undefined) m.message_reference = { message_id: replyToMessageId, fail_if_not_exists: false }
  return m
}

/** 確認回覆：另發一則（不改告警原文）；不 tag 任何人。 */
export function buildAckReply(actorLabel: string, atIso: string, replyToMessageId?: string): DiscordReplyMessage {
  return reply(`🟡 Acknowledged — ${displayActor(actorLabel)} · ${formatAlertTime(atIso)}`, replyToMessageId)
}

/** 解決回覆：手動帶出是誰與時間；自動恢復維持固定文字。不 tag。 */
export function buildResolveReply(
  source: Source,
  replyToMessageId?: string,
  manual?: { actorLabel: string; atIso: string },
): DiscordReplyMessage {
  if (source !== 'manual') return reply(`🟢 Resolved — 自動恢復（${AUTO_SOURCE[source]}）`, replyToMessageId)
  return reply(
    manual !== undefined
      ? `🟢 Resolved — ${displayActor(manual.actorLabel)} · ${formatAlertTime(manual.atIso)}`
      : '🟢 Resolved',
    replyToMessageId,
  )
}

export function buildFollowUpAlert(alert: DiscordMessage, replyToMessageId: string): DiscordMessage {
  const m = structuredClone(alert)
  delete m.components
  m.message_reference = { message_id: replyToMessageId, fail_if_not_exists: false }
  return m
}

/**
 * 依 issue 現況重建根訊息（編輯用）：只更新最新次數／Last seen 與按鈕，其餘內容不動
 * （確認／解決改以另發回覆呈現，見 spec 2026-11-12 修訂）。
 * base 為事故第一則告警原文（或 interaction.message）；輸出一律無 content、`{parse: []}`。
 */
export function renderRoot(
  base: DiscordMessage,
  issue: Pick<StoredIssue, 'id' | 'status' | 'count' | 'lastSeen' | 'acknowledgedBy' | 'acknowledgedAt' | 'reopenCount'>,
): DiscordMessage {
  const m = applyCount(base, issue.count, issue.lastSeen)
  switch (issue.status) {
    case 'open':
    case 'acknowledged': {
      const acked = issue.status === 'acknowledged' || issue.acknowledgedBy !== null
      const out = withAlertButtons(m, issue.id, issue.reopenCount, acked ? ['resolve'] : ['ack', 'resolve'])
      stripMentions(out)
      return out
    }
    case 'resolved':
      return withoutButtons(m)
    case 'ignored':
      return applyIgnored(m)
  }
}

/** 復發時標記上一事故的根訊息：綠色已解決、無按鈕，並指向最新回覆（resolved_* 已被 reopen 清空，故不顯示處理方式）。 */
export function renderPreviousIncidentRoot(base: DiscordMessage, reopenCount: number): DiscordMessage {
  const m = structuredClone(base)
  stripMentions(m)
  delete m.components
  m.embeds[0].color = GREEN
  m.embeds[0].title = prefixTitle(m.embeds[0].title, '🟢 Resolved')
  upsertField(m.embeds[0].fields, {
    name: REOPENED_FIELD,
    value: `第 ${reopenCount} 次，見最新回覆`,
    inline: false,
  })
  return m
}
