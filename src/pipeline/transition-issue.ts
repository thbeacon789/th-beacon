import { actorLabel, allowedFrom, type IssueActor } from '@/core/lifecycle'
import type { IssueStatus } from '@/core/types'
import { refreshServiceHealth } from '@/pipeline/refresh-health'
import type { DiscordBot } from '@/notify/discord-bot'
import { buildResolveReply, renderRoot } from '@/notify/lifecycle-message'
import type { DiscordMessage } from '@/notify/message'
import type { Store, StoredIssue } from '@/store/contracts'

export interface TransitionOptions {
  refreshHealth?: boolean
  editRoot?: boolean
  /** 僅當 issue 仍在此事故序號時才轉換（防按鈕 TOCTOU） */
  expectedReopenCount?: number
}

export interface TransitionResult {
  outcome: 'changed' | 'unchanged' | 'not_found'
  issue: StoredIssue | null
  /** 新的根訊息內容；editRoot=false 時由呼叫端自行送出 */
  rootEdit: { channelId: string; messageId: string; payload: DiscordMessage } | null
  /** 健康度重算、解決回覆、Discord 編輯（editRoot=true 時） */
  followUp: () => Promise<void>
}

type Source = 'manual' | 'poll' | 'heartbeat'

function sourceOf(actor: IssueActor): Source {
  return actor.kind === 'system' ? actor.source : 'manual'
}

export function transformRoot(
  payload: DiscordMessage,
  issue: StoredIssue,
  actor: IssueActor,
): DiscordMessage {
  return renderRoot(payload, issue, sourceOf(actor))
}

async function safely(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    console.error(`transitionIssue: ${what} failed`, error)
  }
}

/** issue 狀態轉移的單一出口：寫 DB（含誰／何時）→ 重算健康度 → 更新 Discord 根訊息與解決回覆。 */
export async function transitionIssue(
  store: Store,
  bot: DiscordBot | null,
  issueId: string,
  to: IssueStatus,
  actor: IssueActor,
  now: Date,
  options: TransitionOptions & { deferFollowUp?: boolean } = {},
): Promise<TransitionResult> {
  const { refreshHealth = true, editRoot = true, deferFollowUp = false, expectedReopenCount } = options
  const nowIso = now.toISOString()
  const noop = async (): Promise<void> => {}

  const result = await store.transitionIssueStatus(issueId, to, allowedFrom(to), actorLabel(actor), nowIso, expectedReopenCount)
  if (result === null) return { outcome: 'not_found', issue: null, rootEdit: null, followUp: noop }
  if (!result.changed) return { outcome: 'unchanged', issue: result.issue, rootEdit: null, followUp: noop }

  const issue = result.issue
  let rootEdit: TransitionResult['rootEdit'] = null
  if (bot !== null) {
    try {
      const root = await store.getIncidentRoot(issue.id, issue.reopenCount)
      // channelId 為空字串＝store 對 null channel 的退化，視同沒有根訊息
      if (root !== null && root.channelId !== '') {
        rootEdit = {
          channelId: root.channelId,
          messageId: root.messageId,
          payload: transformRoot(root.payload, issue, actor),
        }
      }
    } catch (error) {
      // Discord 是投影：DB 已寫入，取根訊息失敗只當作沒有根訊息
      console.error('transitionIssue: load root failed', error)
    }
  }

  const followUp = async (): Promise<void> => {
    if (refreshHealth) {
      await safely('refreshServiceHealth', () => refreshServiceHealth(store, issue.serviceId, now))
    }
    if (bot === null || rootEdit === null) return
    if (editRoot) {
      await safely('edit root', () => bot.edit(rootEdit.channelId, rootEdit.messageId, rootEdit.payload))
    }
    if (to === 'resolved') {
      await safely('resolve reply', async () => {
        const reply = await bot.post(buildResolveReply(sourceOf(actor), rootEdit.messageId))
        await store.recordNotification({
          issueId: issue.id,
          serviceId: issue.serviceId,
          fingerprint: issue.fingerprint,
          severity: issue.severity,
          status: reply.ok ? 'sent' : 'failed',
          countAtSend: issue.count,
          sentAt: nowIso,
          kind: 'resolve_reply',
          incidentSeq: issue.reopenCount,
          discordChannelId: reply.ok ? reply.channelId : null,
          discordMessageId: reply.ok ? reply.messageId : null,
          payload: null,
        })
      })
    }
  }

  if (!deferFollowUp) await followUp()
  return { outcome: 'changed', issue, rootEdit, followUp }
}
