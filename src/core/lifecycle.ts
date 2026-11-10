import type { IssueStatus } from './types'

export type IssueActor =
  | { kind: 'discord'; userId: string }
  | { kind: 'dashboard'; email: string }
  | { kind: 'system'; source: 'poll' | 'heartbeat' }

const ALLOWED_FROM: Record<IssueStatus, readonly IssueStatus[]> = {
  acknowledged: ['open'],
  resolved: ['open', 'acknowledged'],
  ignored: ['open', 'acknowledged', 'resolved'],
  open: ['acknowledged', 'resolved', 'ignored'],
}

/** 轉移到 `to` 時合法的來源狀態。 */
export function allowedFrom(to: IssueStatus): readonly IssueStatus[] {
  return ALLOWED_FROM[to]
}

const DISCORD_PREFIX = 'discord:'

export function actorLabel(actor: IssueActor): string | null {
  switch (actor.kind) {
    case 'discord':
      return `${DISCORD_PREFIX}${actor.userId}`
    case 'dashboard':
      return actor.email
    case 'system':
      return null
  }
}

export function displayActor(label: string): string {
  return label.startsWith(DISCORD_PREFIX) ? `<@${label.slice(DISCORD_PREFIX.length)}>` : label
}

export type ButtonAction = 'ack' | 'resolve'

// core 不能 import web，自帶 UUID 檢查。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function encodeButtonId(action: ButtonAction, issueId: string, incidentSeq: number): string {
  return `${action}:${issueId}:${incidentSeq}`
}

export function parseButtonId(
  customId: string,
): { action: ButtonAction; issueId: string; incidentSeq: number } | null {
  const parts = customId.split(':')
  if (parts.length !== 3) return null
  const [action, issueId, seq] = parts
  if (action !== 'ack' && action !== 'resolve') return null
  if (!UUID_RE.test(issueId)) return null
  if (!/^\d+$/.test(seq)) return null
  const incidentSeq = Number(seq)
  if (!Number.isSafeInteger(incidentSeq)) return null
  return { action, issueId, incidentSeq }
}
