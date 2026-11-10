import { applyTriage, type ProcessResult } from '@/pipeline/process-event'
import {
  AI_STATS_WINDOW_DAYS,
  AI_TRIAGE_MODEL,
  buildTriagePrompt,
  decideTriage,
  summarizeServiceIssues,
  type TriageDecision,
} from '@/core/ai-triage'
import { DIAGNOSIS_ERROR_LIMIT, truncateText } from '@/core/heartbeat'
import type { Triager, TriageCallResult } from '@/triage/claude'
import { shouldNotify } from '@/notify/decision'
import { buildDiscordMessage, extractNotifyDetails, type DiscordMessage } from '@/notify/message'
import {
  buildFollowUpAlert,
  renderPreviousIncidentRoot,
  renderRoot,
} from '@/notify/lifecycle-message'
import type { DiscordSender } from '@/notify/discord'
import type { DiscordBot } from '@/notify/discord-bot'
import type { CanonicalEvent, IssueAiTriage, Severity } from '@/core/types'
import type { ServiceRecord, Store, UpsertOutcome } from '@/store/contracts'

export interface TriageDeps {
  triager: Triager | null
  /** null = 不限；呼叫 triager 前遞減 */
  budget: { remaining: number } | null
}

export interface NotifyDeps {
  sender: DiscordSender
  fallbackWebhookUrl: string | null
  dashboardUrl?: string
  /** 有值 = 告警改由 Bot 發到指定頻道；null／未提供 = 沿用 webhook */
  bot?: DiscordBot | null
  /** 未提供 = 停用 AI 判級（行為同未導入前） */
  triage?: TriageDeps
}

export interface ProcessAndNotifyResult extends ProcessResult {
  notified: boolean
  notifyReason: string | null
}

export interface StagedEvent {
  event: CanonicalEvent
  service: ServiceRecord
  upsert: UpsertOutcome
  decision: TriageDecision
}

/** 第一階段：upsert ＋ 決定這個 event 要不要呼叫 AI（不做任何 AI／判級）。 */
export async function stageEvent(
  store: Store,
  deps: NotifyDeps,
  event: CanonicalEvent,
  now: Date,
): Promise<StagedEvent> {
  const service = await store.getService(event.serviceId)
  if (service === null) throw new Error(`unknown service: ${event.serviceId}`)
  const upsert = await store.upsertIssueWithEvent(event)
  const triageOn = deps.triage?.triager != null
  const decision: TriageDecision =
    upsert.duplicate || !triageOn
      ? event.severity !== undefined
        ? { kind: 'ci' }
        : { kind: 'no_ai' }
      : decideTriage({
          event,
          created: upsert.created,
          reopened: upsert.reopened,
          issueAi: upsert.issue.ai,
          firstSeen: upsert.issue.firstSeen,
          now,
          budgetRemaining: deps.triage?.budget?.remaining ?? null,
        })
  return { event, service, upsert, decision }
}

/** 第二階段：（必要時）呼叫 AI → 判級 → 健康度 → 通知。同一 event 至多呼叫 triager 一次。 */
export async function finishEvent(
  store: Store,
  deps: NotifyDeps,
  staged: StagedEvent,
  now: Date,
): Promise<ProcessAndNotifyResult> {
  const { event, service, upsert, decision } = staged
  if (upsert.duplicate) {
    const result = await applyTriage(store, service, event, upsert, null, now)
    return safeNotify(store, deps, event, result, now)
  }

  let ai: Severity | null = null
  let notifyEvent = event
  let record: IssueAiTriage | null = null
  if (decision.kind === 'reuse') {
    ai = decision.ai.severity
    notifyEvent = withMetadata(event, aiMetadata(decision.ai))
  } else if (decision.kind === 'call') {
    const outcome = await runTriager(store, deps, staged, now)
    ai = outcome.ai
    record = outcome.record
    notifyEvent = withMetadata(event, outcome.metadata)
  } else if (decision.kind === 'skip_budget') {
    notifyEvent = withMetadata(event, { diagnosisError: SKIP_BUDGET_TEXT })
  }

  const applied = await applyTriage(store, service, event, upsert, ai, now)
  const result = record === null ? applied : { ...applied, issue: { ...applied.issue, ai: record } }
  return safeNotify(store, deps, notifyEvent, result, now)
}

export async function processAndNotify(
  store: Store,
  deps: NotifyDeps,
  event: CanonicalEvent,
  now: Date,
): Promise<ProcessAndNotifyResult> {
  return finishEvent(store, deps, await stageEvent(store, deps, event, now), now)
}

// 通知區塊標題已是「AI 判讀失敗」，內容不再加前綴；略過是例外，需自說明。
const SKIP_BUDGET_TEXT = '略過：本輪呼叫數已達上限'

function withMetadata(event: CanonicalEvent, extra: Record<string, unknown>): CanonicalEvent {
  return { ...event, metadata: { ...event.metadata, ...extra } }
}

function aiMetadata(ai: IssueAiTriage): Record<string, unknown> {
  if (ai.severity !== null && ai.category !== null && ai.reason !== null && ai.suggestion !== null) {
    return { diagnosis: { category: ai.category, severity: ai.severity, reason: ai.reason, suggestion: ai.suggestion } }
  }
  return ai.error !== null ? { diagnosisError: ai.error } : {}
}

async function runTriager(
  store: Store,
  deps: NotifyDeps,
  staged: StagedEvent,
  now: Date,
): Promise<{ ai: Severity | null; metadata: Record<string, unknown>; record: IssueAiTriage | null }> {
  const { event, service, upsert } = staged
  const triage = deps.triage
  const triager = triage?.triager
  if (triage === undefined || triager == null) return { ai: null, metadata: {}, record: null }
  if (triage.budget !== null) triage.budget.remaining--

  let call: TriageCallResult
  try {
    const [open, recent] = await Promise.all([
      store.listOpenIssues(event.serviceId),
      store.listRecentIssues(event.serviceId, new Date(now.getTime() - AI_STATS_WINDOW_DAYS * 86_400_000).toISOString()),
    ])
    // OpenIssue 不含 id：以「同 errorType 且等級同本 issue」的第一筆視為本 issue 排除。
    const selfIndex = open.findIndex(
      (o) => o.errorType === upsert.issue.errorType && o.severity === upsert.issue.severity,
    )
    const others = open.filter((_, i) => i !== selfIndex).map((o) => ({ errorType: o.errorType, severity: o.severity }))
    const prompt = buildTriagePrompt({
      service: { name: service.name, description: service.description },
      event,
      issue: {
        count: upsert.issue.count,
        firstSeen: upsert.issue.firstSeen,
        lastSeen: upsert.issue.lastSeen,
        reopened: upsert.reopened,
        previousAiSeverity: upsert.issue.ai?.severity ?? null,
      },
      otherOpenIssues: others,
      serviceStats: summarizeServiceIssues(recent, now, AI_STATS_WINDOW_DAYS),
    })
    call = await triager(prompt)
  } catch (error) {
    call = { ok: false, error: truncateText(error instanceof Error ? `${error.name}: ${error.message}` : String(error), DIAGNOSIS_ERROR_LIMIT) }
  }

  const judgedAt = now.toISOString()
  const record: IssueAiTriage = call.ok
    ? {
        severity: call.diagnosis.severity,
        category: call.diagnosis.category,
        reason: call.diagnosis.reason,
        suggestion: call.diagnosis.suggestion,
        model: call.diagnosis.model ?? AI_TRIAGE_MODEL,
        judgedAt,
        error: null,
      }
    : { severity: null, category: null, reason: null, suggestion: null, model: null, judgedAt, error: call.error }
  try {
    await store.recordIssueAiTriage(upsert.issue.id, record)
  } catch (error) {
    console.error('recordIssueAiTriage failed:', error)
  }
  return { ai: record.severity, metadata: aiMetadata(record), record }
}

async function safeNotify(
  store: Store,
  deps: NotifyDeps,
  event: CanonicalEvent,
  result: ProcessResult,
  now: Date,
): Promise<ProcessAndNotifyResult> {
  try {
    return { ...result, ...(await notifyStage(store, deps, event, result, now)) }
  } catch (error) {
    // 事件已成功入庫/判級/更新健康度——通知層故障不得把它變成 5xx（會誘發重試重複計數）
    console.error('notify stage failed:', error)
    return { ...result, notified: false, notifyReason: 'notify_error' }
  }
}

async function notifyStage(
  store: Store,
  deps: NotifyDeps,
  event: CanonicalEvent,
  result: ProcessResult,
  now: Date,
): Promise<{ notified: boolean; notifyReason: string | null }> {
  // 事件自帶 severity（AI 判讀）時以它為準；ratchet 只管 issue 狀態，不影響通知顏色／紀錄
  const severity = event.severity ?? result.issue.severity
  const lastSent = await store.getLatestSentNotification(
    event.serviceId,
    result.issue.fingerprint,
    result.issue.reopenCount,
  )
  const decision = shouldNotify({
    severity,
    duplicate: result.duplicate,
    lastSent,
    now,
  })
  if (!decision.notify) return { notified: false, notifyReason: decision.reason }

  const service = await store.getService(event.serviceId)
  const bot = deps.bot ?? null
  const webhookUrl = service?.discordWebhookUrl ?? deps.fallbackWebhookUrl
  if (service === null || (bot === null && webhookUrl === null)) {
    return { notified: false, notifyReason: 'no_webhook' }
  }

  const { issue } = result
  const seq = issue.reopenCount
  const baseRecord = {
    issueId: issue.id,
    serviceId: event.serviceId,
    fingerprint: issue.fingerprint,
    severity,
    countAtSend: issue.count,
    sentAt: now.toISOString(),
    incidentSeq: seq,
  }

  if (bot !== null && issue.status === 'acknowledged' && decision.reason === 'cooldown_expired') {
    await editAcknowledgedCount(store, bot, result, baseRecord)
    return { notified: false, notifyReason: 'acknowledged_silent' }
  }

  const root = bot !== null ? await store.getIncidentRoot(issue.id, seq) : null
  // 已確認後才發根訊息（首則失敗、之後有人確認）：不得再 tag 負責人
  const quietRoot = bot !== null && root === null && issue.status === 'acknowledged' && decision.reason === 'first'
  const built = buildDiscordMessage({
    serviceName: service.name,
    ownerDiscordId: quietRoot ? null : service.ownerDiscordId,
    severity,
    errorType: issue.errorType,
    message: issue.message,
    count: issue.count,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    ...(deps.dashboardUrl !== undefined ? { dashboardUrl: deps.dashboardUrl } : {}),
    details: extractNotifyDetails(event.metadata),
    ...(bot !== null && root === null && !quietRoot ? { buttons: { issueId: issue.id, incidentSeq: seq } } : {}),
  })

  if (bot === null) {
    const sendResult = await deps.sender(webhookUrl as string, built)
    await store.recordNotification({
      ...baseRecord,
      status: sendResult.ok ? 'sent' : 'failed',
      kind: 'alert',
      discordChannelId: null,
      discordMessageId: null,
      payload: null,
    })
    return { notified: sendResult.ok, notifyReason: decision.reason }
  }

  let outgoing: DiscordMessage = quietRoot ? renderRoot(built, issue) : built
  let prev: Awaited<ReturnType<Store['getIncidentRoot']>> = null
  if (root !== null) {
    outgoing = buildFollowUpAlert(built, root.messageId)
  } else if (seq > 0) {
    // 不依賴 result.reopened：新事故首則 post 失敗時，下個事件仍要接回上一事故
    prev = await store.getIncidentRoot(issue.id, seq - 1)
    if (prev !== null) {
      outgoing = {
        ...outgoing,
        message_reference: { message_id: prev.messageId, fail_if_not_exists: false },
      }
    }
  }

  const post = await bot.post(outgoing)
  const { message_reference: _ref, ...stored } = outgoing
  await store.recordNotification({
    ...baseRecord,
    status: post.ok ? 'sent' : 'failed',
    kind: 'alert',
    discordChannelId: post.ok ? post.channelId : null,
    discordMessageId: post.ok ? post.messageId : null,
    payload: stored,
  })
  if (post.ok && prev !== null) {
    // 新告警送出成功後才標記上一則已復發；失敗則留待下次重試
    try {
      const edited = await bot.edit(prev.channelId, prev.messageId, renderPreviousIncidentRoot(prev.payload, seq))
      if (!edited.ok) console.error('mark previous incident reopened failed:', edited.reason)
    } catch (error) {
      console.error('mark previous incident reopened failed:', error)
    }
  }
  return { notified: post.ok, notifyReason: decision.reason }
}

/** 已確認 issue 冷卻到期：不再 post，只靜默更新根訊息的計數（保留「已確認」與按鈕狀態）。 */
async function editAcknowledgedCount(
  store: Store,
  bot: DiscordBot,
  result: ProcessResult,
  base: {
    issueId: string
    serviceId: string
    fingerprint: string
    severity: Severity
    countAtSend: number
    sentAt: string
    incidentSeq: number
  },
): Promise<void> {
  const { issue } = result
  const root = await store.getIncidentRoot(issue.id, base.incidentSeq)
  if (root === null) return
  let ok = false
  try {
    const edited = await bot.edit(root.channelId, root.messageId, renderRoot(root.payload, issue))
    ok = edited.ok
    if (!edited.ok) console.error('count edit failed:', edited.reason)
  } catch (error) {
    console.error('count edit failed:', error)
  }
  await store.recordNotification({
    ...base,
    status: ok ? 'sent' : 'failed',
    kind: 'count_edit',
    discordChannelId: root.channelId,
    discordMessageId: root.messageId,
    payload: null,
  })
}
