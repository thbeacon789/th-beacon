import { verifyIngestSignature } from '@/ingest/hmac'
import type { IngestRequest, IngestResponse } from '@/ingest/handle-ingest'
import { parseAiFixPayload } from '@/ai-fix/payload'
import { heartbeatFingerprint } from '@/core/heartbeat'
import type { DiscordBot } from '@/notify/discord-bot'
import { buildAiFixReply } from '@/notify/lifecycle-message'
import { postInThread } from '@/notify/thread'
import type { Store } from '@/store/contracts'

const UNAUTHORIZED: IngestResponse = { status: 401, body: { error: 'unauthorized' } }

/**
 * CI 回報 AI 修復結果：由心跳名稱對應到 test_failure issue，存結果，
 * 並在該告警的討論串通知負責人。通知失敗不影響回應碼（資料已存即 201）。
 */
export async function handleAiFix(
  store: Store,
  bot: DiscordBot | null,
  request: IngestRequest,
  now: Date,
): Promise<IngestResponse> {
  if (request.serviceName === null || request.timestamp === null || request.signature === null) {
    return UNAUTHORIZED
  }

  const auth = await store.getServiceByName(request.serviceName)
  if (auth === null || auth.webhookSecret === null) return UNAUTHORIZED

  const verdict = verifyIngestSignature({
    secret: auth.webhookSecret,
    rawBody: request.rawBody,
    timestamp: request.timestamp,
    signature: request.signature,
    now,
  })
  if (!verdict.ok) return UNAUTHORIZED

  let json: unknown
  try {
    json = JSON.parse(request.rawBody)
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } }
  }

  const parsed = parseAiFixPayload(json)
  if (!parsed.ok) return { status: 422, body: { error: 'invalid payload', details: parsed.errors } }

  const report = parsed.value
  const serviceId = auth.service.id

  const heartbeat = await store.getHeartbeat(serviceId, report.heartbeat)
  if (heartbeat === null) return { status: 404, body: { error: 'unknown heartbeat' } }

  const ids = await store.findActiveIssueIds(serviceId, {
    fingerprint: heartbeatFingerprint(serviceId, 'test_failure', report.heartbeat),
  })
  if (ids.length === 0) return { status: 404, body: { error: 'no_active_issue' } }

  const issue = await store.getIssue(ids[0])
  if (issue === null) return { status: 404, body: { error: 'no_active_issue' } }

  const prUrl = report.status === 'pr_opened' ? report.prUrl : null
  const previousPrUrl = issue.aiFix?.prUrl ?? null
  await store.recordIssueAiFix(issue.id, {
    status: report.status,
    prUrl,
    summary: report.summary,
    reportedAt: now.toISOString(),
  })

  let notified = false
  if (prUrl !== null && prUrl !== previousPrUrl && bot !== null) {
    try {
      const root = await store.getIncidentRoot(issue.id, issue.reopenCount)
      if (root !== null && root.channelId !== '') {
        const result = await postInThread(bot, root, (replyTo) =>
          buildAiFixReply(
            { prUrl, summary: report.summary, ownerDiscordId: auth.service.ownerDiscordId, runUrl: report.runUrl },
            replyTo,
          ),
        )
        notified = result.ok
      }
    } catch (error) {
      console.error('handleAiFix: thread notify failed', error)
    }
  }

  return { status: 201, body: { issueId: issue.id, notified } }
}
