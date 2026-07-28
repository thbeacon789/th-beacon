import { synthesizeHealthCheckFailedEvent, normalizePolledError } from '@/core/normalize'
import { processEvent } from '@/pipeline/process-event'
import { refreshServiceHealth } from '@/pipeline/refresh-health'
import { isPollDue } from '@/poll/due'
import { parsePolledErrors } from '@/poll/parse'
import type { PollableService, Store } from '@/store/contracts'

export type HttpResult =
  | { ok: true; status: number; bodyText: string }
  | { ok: false; reason: string }

export type HttpGet = (url: string, timeoutMs: number) => Promise<HttpResult>

export interface PollOutcome {
  serviceId: string
  healthChecked: boolean
  healthy: boolean | null
  healthIssueResolved: boolean
  errorsProcessed: number
  errorsTruncated: boolean
  errorFetchFailed: boolean
  error?: string
}

export async function pollService(
  store: Store,
  http: HttpGet,
  pollable: PollableService,
  now: Date,
): Promise<PollOutcome> {
  const { service, config } = pollable
  const outcome: PollOutcome = {
    serviceId: service.id,
    healthChecked: false,
    healthy: null,
    healthIssueResolved: false,
    errorsProcessed: 0,
    errorsTruncated: false,
    errorFetchFailed: false,
  }
  let consecutiveFailures = service.poll?.consecutiveFailures ?? 0

  if (config.healthUrl !== null) {
    outcome.healthChecked = true
    const result = await http(config.healthUrl, config.timeoutMs)
    const healthy = result.ok && result.status === config.expectedStatus
    outcome.healthy = healthy
    if (healthy) {
      consecutiveFailures = 0
      await store.updatePollState(service.id, {
        lastPollAt: now.toISOString(),
        healthy: true,
        consecutiveFailures,
      })
      outcome.healthIssueResolved = await store.resolveHealthCheckIssue(service.id)
      await refreshServiceHealth(store, service.id, now)
    } else {
      consecutiveFailures += 1
      // 先寫回 PollState，processEvent 內的 deriveHealth 才讀得到最新失敗數
      await store.updatePollState(service.id, {
        lastPollAt: now.toISOString(),
        healthy: false,
        consecutiveFailures,
      })
      const reason = result.ok ? `unexpected status ${result.status}` : result.reason
      const event = synthesizeHealthCheckFailedEvent(
        service.id,
        {
          reason,
          ...(result.ok ? { statusCode: result.status } : {}),
          url: config.healthUrl,
        },
        now,
      )
      await processEvent(store, event, now)
    }
  } else {
    // error-only 服務也記錄輪詢時刻，並重算健康度（覆蓋過期窗口）
    await store.updatePollState(service.id, {
      lastPollAt: now.toISOString(),
      healthy: null,
      consecutiveFailures,
    })
    await refreshServiceHealth(store, service.id, now)
  }

  if (config.errorUrl !== null) {
    const url =
      config.cursor === null
        ? config.errorUrl
        : `${config.errorUrl}${config.errorUrl.includes('?') ? '&' : '?'}since=${encodeURIComponent(config.cursor)}`
    const result = await http(url, config.timeoutMs)
    if (!result.ok || result.status !== 200) {
      outcome.errorFetchFailed = true
    } else {
      let parsed: ReturnType<typeof parsePolledErrors> | null = null
      try {
        parsed = parsePolledErrors(JSON.parse(result.bodyText))
      } catch {
        parsed = null
      }
      if (parsed === null || !parsed.ok) {
        outcome.errorFetchFailed = true
      } else {
        for (const raw of parsed.value) {
          await processEvent(store, normalizePolledError(service.id, raw, now), now)
        }
        outcome.errorsProcessed = parsed.value.length
        outcome.errorsTruncated = parsed.truncated
        await store.updatePollState(service.id, {
          lastPollAt: now.toISOString(),
          healthy: outcome.healthy,
          consecutiveFailures,
          cursor: now.toISOString(),
        })
      }
    }
  }

  return outcome
}

export async function runPoll(store: Store, http: HttpGet, now: Date): Promise<PollOutcome[]> {
  const pollables = await store.listPollableServices()
  const due = pollables.filter((p) => isPollDue(p.lastPollAt, p.config.intervalSeconds, now))
  const outcomes: PollOutcome[] = []
  for (const pollable of due) {
    try {
      outcomes.push(await pollService(store, http, pollable, now))
    } catch (error) {
      // 單一服務失敗不得中斷整輪：記為 outcome，繼續下一個
      outcomes.push({
        serviceId: pollable.service.id,
        healthChecked: false,
        healthy: null,
        healthIssueResolved: false,
        errorsProcessed: 0,
        errorsTruncated: false,
        errorFetchFailed: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return outcomes
}
