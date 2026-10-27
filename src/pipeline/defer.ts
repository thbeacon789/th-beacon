import { finishEvent, stageEvent } from '@/pipeline/process-and-notify'
import type { NotifyDeps, ProcessAndNotifyResult } from '@/pipeline/process-and-notify'
import type { CanonicalEvent } from '@/core/types'
import type { Store } from '@/store/contracts'

/** 排程「回應送出後」才執行的工作（route 端接 next/server 的 after）。task 本身保證不 reject。 */
export type Defer = (task: () => Promise<void>) => void

export type StagedOutcome =
  | { triage: 'deferred'; issueId: string; result?: undefined }
  | { triage: 'sync'; issueId: string; result: ProcessAndNotifyResult }

/**
 * stageEvent 後：需呼叫 AI 且有 defer → 把 finishEvent 丟到回應之後；否則同步完成。
 * deferred 時只保證 issue 已入庫（issueId 可回），等級／通知尚未決定。
 */
export async function processWithOptionalDefer(
  store: Store,
  deps: NotifyDeps,
  event: CanonicalEvent,
  now: Date,
  defer?: Defer,
): Promise<StagedOutcome> {
  const staged = await stageEvent(store, deps, event, now)
  if (staged.decision.kind === 'call' && defer !== undefined) {
    defer(async () => {
      try {
        await finishEvent(store, deps, staged, now)
      } catch (error) {
        console.error('deferred finishEvent failed:', error)
      }
    })
    return { triage: 'deferred', issueId: staged.upsert.issue.id }
  }
  return { triage: 'sync', issueId: staged.upsert.issue.id, result: await finishEvent(store, deps, staged, now) }
}
