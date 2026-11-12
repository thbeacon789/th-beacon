import { displayActor, encodeButtonId, type ButtonAction } from '@/core/lifecycle'
import type { StoredIssue } from '@/store/contracts'
import { formatAlertTime, type DiscordEmbedField, type DiscordMessage, type DiscordReplyMessage } from './message'

const GREEN = 0x2ecc71
const GREY = 0x95a5a6

type Source = 'manual' | 'poll' | 'heartbeat'

function prefixTitle(title: string, prefix: string): string {
  return title.startsWith(`${prefix} `) ? title : `${prefix} ${title}`
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
    ack: { type: 2 as const, style: 2 as const, label: '✋ 確認' },
    resolve: { type: 2 as const, style: 3 as const, label: '✅ 已解決' },
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

export function applyAcknowledged(
  msg: DiscordMessage,
  actorLabel: string,
  atIso: string,
  issueId: string,
  incidentSeq: number,
): DiscordMessage {
  const m = structuredClone(msg)
  stripMentions(m)
  upsertField(m.embeds[0].fields, {
    name: '✋ 已確認',
    value: `${displayActor(actorLabel)}（${formatAlertTime(atIso)}）`,
    inline: false,
  })
  m.components = [buttonRow(issueId, incidentSeq, ['resolve'])]
  return m
}

export function applyResolved(
  msg: DiscordMessage,
  resolution: { actorLabel: string | null; source: Source },
): DiscordMessage {
  const m = structuredClone(msg)
  stripMentions(m)
  delete m.components
  const e = m.embeds[0]
  e.color = GREEN
  e.title = prefixTitle(e.title, '✅ 已解決')
  const how =
    resolution.source === 'manual'
      ? `手動：${displayActor(resolution.actorLabel ?? '')}`
      : resolution.source === 'poll'
        ? '自動恢復（輪詢）'
        : '自動恢復（心跳）'
  upsertField(e.fields, { name: '處理方式', value: how, inline: false })
  return m
}

export function applyIgnored(msg: DiscordMessage): DiscordMessage {
  const m = structuredClone(msg)
  stripMentions(m)
  delete m.components
  m.embeds[0].color = GREY
  m.embeds[0].title = prefixTitle(m.embeds[0].title, '🚫 已忽略')
  return m
}

export function applyReopened(msg: DiscordMessage, reopenCount: number): DiscordMessage {
  const m = structuredClone(msg)
  stripMentions(m)
  delete m.components
  upsertField(m.embeds[0].fields, {
    name: '🔁 已復發',
    value: `第 ${reopenCount} 次 → 見最新回覆`,
    inline: false,
  })
  return m
}

export function applyCount(msg: DiscordMessage, count: number, lastSeen: string): DiscordMessage {
  const m = structuredClone(msg)
  for (const f of m.embeds[0].fields) {
    if (f.name === '次數') f.value = String(count)
    else if (f.name === 'Last seen') f.value = formatAlertTime(lastSeen)
  }
  return m
}

export function buildResolveReply(source: Source, replyToMessageId: string): DiscordReplyMessage {
  return {
    username: 'th-beacon',
    content: source === 'manual' ? '✅ 已解決' : '✅ 已自動恢復',
    allowed_mentions: { parse: [] },
    message_reference: { message_id: replyToMessageId, fail_if_not_exists: false },
  }
}

export function buildFollowUpAlert(alert: DiscordMessage, replyToMessageId: string): DiscordMessage {
  const m = structuredClone(alert)
  delete m.components
  m.message_reference = { message_id: replyToMessageId, fail_if_not_exists: false }
  return m
}

/**
 * 依 issue 現況完整重建根訊息（編輯用）：最新次數 → 已確認欄位 → 依狀態套樣式。
 * base 為事故第一則告警原文（或 interaction.message）；輸出一律無 content、`{parse: []}`。
 */
export function renderRoot(
  base: DiscordMessage,
  issue: Pick<
    StoredIssue,
    'id' | 'status' | 'count' | 'lastSeen' | 'acknowledgedBy' | 'acknowledgedAt' | 'resolvedBy' | 'reopenCount'
  >,
  resolutionSource: Source = 'manual',
): DiscordMessage {
  let m = applyCount(base, issue.count, issue.lastSeen)
  const acked = issue.acknowledgedBy !== null && issue.acknowledgedAt !== null
  if (acked) {
    m = applyAcknowledged(m, issue.acknowledgedBy as string, issue.acknowledgedAt as string, issue.id, issue.reopenCount)
  }
  switch (issue.status) {
    case 'open':
    case 'acknowledged': {
      m = withAlertButtons(m, issue.id, issue.reopenCount, acked ? ['resolve'] : issue.status === 'open' ? ['ack', 'resolve'] : ['resolve'])
      stripMentions(m)
      return m
    }
    case 'resolved':
      return applyResolved(m, { actorLabel: issue.resolvedBy, source: resolutionSource })
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
  m.embeds[0].title = prefixTitle(m.embeds[0].title, '✅ 已解決')
  upsertField(m.embeds[0].fields, {
    name: '🔁 已復發',
    value: `第 ${reopenCount} 次 → 見最新回覆`,
    inline: false,
  })
  return m
}
