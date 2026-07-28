import { processEvent, type ProcessResult } from '@/pipeline/process-event'
import { shouldNotify } from '@/notify/decision'
import { buildDiscordMessage, extractNotifyDetails } from '@/notify/message'
import type { DiscordSender } from '@/notify/discord'
import type { CanonicalEvent } from '@/core/types'
import type { Store } from '@/store/contracts'

export interface NotifyDeps {
  sender: DiscordSender
  fallbackWebhookUrl: string | null
  dashboardUrl?: string
}

export interface ProcessAndNotifyResult extends ProcessResult {
  notified: boolean
  notifyReason: string | null
}

export async function processAndNotify(
  store: Store,
  deps: NotifyDeps,
  event: CanonicalEvent,
  now: Date,
): Promise<ProcessAndNotifyResult> {
  const result = await processEvent(store, event, now)
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
  const lastSent = await store.getLatestSentNotification(event.serviceId, result.issue.fingerprint)
  const decision = shouldNotify({
    severity: result.issue.severity,
    duplicate: result.duplicate,
    lastSent,
    now,
  })
  if (!decision.notify) return { notified: false, notifyReason: decision.reason }

  const service = await store.getService(event.serviceId)
  const webhookUrl = service?.discordWebhookUrl ?? deps.fallbackWebhookUrl
  if (service === null || webhookUrl === null) {
    return { notified: false, notifyReason: 'no_webhook' }
  }

  const message = buildDiscordMessage({
    serviceName: service.name,
    severity: result.issue.severity,
    errorType: result.issue.errorType,
    message: result.issue.message,
    count: result.issue.count,
    firstSeen: result.issue.firstSeen,
    lastSeen: result.issue.lastSeen,
    ...(deps.dashboardUrl !== undefined ? { dashboardUrl: deps.dashboardUrl } : {}),
    details: extractNotifyDetails(event.metadata),
  })
  const sendResult = await deps.sender(webhookUrl, message)
  await store.recordNotification({
    issueId: result.issue.id,
    serviceId: event.serviceId,
    fingerprint: result.issue.fingerprint,
    severity: result.issue.severity,
    status: sendResult.ok ? 'sent' : 'failed',
    countAtSend: result.issue.count,
    sentAt: now.toISOString(),
  })
  return { notified: sendResult.ok, notifyReason: decision.reason }
}
