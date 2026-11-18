import type { CheckStatus, Evaluation, Finding, Inventory, ScanKind } from './types.ts'

const RECOMMENDATION = '確認是否為團隊成員所為；若否，視為入侵跡象處理'

export function pickBaseline<T extends { scannedAt: string; inventory: Inventory | null }>(history: T[]): Inventory | null {
  let best: T | null = null
  for (const h of history) {
    if (h.inventory === null) continue
    if (best === null || h.scannedAt < best.scannedAt) best = h
  }
  return best?.inventory ?? null
}

function added<T>(cur: T[], base: T[], key: (x: T) => string): T[] {
  const seen = new Set(base.map(key))
  return cur.filter((x) => !seen.has(key(x)))
}

export function evaluateChanges(kind: ScanKind, current: Inventory | undefined, baseline: Inventory | null): Evaluation {
  if (kind === 'hosted') return { check: { status: 'na', summary: '' }, findings: [] }
  if (!current) return { check: { status: 'unknown', summary: '未取得清冊' }, findings: [] }
  if (baseline === null) return { check: { status: 'unknown', summary: '基準建立中' }, findings: [] }

  const findings: Finding[] = []
  const add = (severity: Finding['severity'], title: string) =>
    findings.push({ check: 'changes', severity, title, recommendation: RECOMMENDATION })

  const newAdmins = added(current.admins, baseline.admins, (x) => x)
  const newAdminSet = new Set(newAdmins)
  for (const name of newAdmins) add('high', `新增管理員帳號 ${name}`)
  for (const k of added(current.sshKeys, baseline.sshKeys, (x) => `${x.user}\0${x.fingerprint}`)) {
    add('high', `${k.user} 新增 SSH 金鑰 ${k.fingerprint}`)
  }
  for (const name of added(current.users, baseline.users, (x) => x)) {
    if (!newAdminSet.has(name)) add('medium', `新增帳號 ${name}`)
  }
  for (const s of added(current.scheduled, baseline.scheduled, (x) => `${x.location}\0${x.hash}`)) {
    add('medium', `新增或變更排程 ${s.location}`)
  }
  for (const l of added(current.listeners, baseline.listeners, (x) => `${x.proto}\0${x.port}`)) {
    add('medium', `新增監聽埠 ${l.proto}/${l.port}（${l.process}）`)
  }
  for (const name of added(current.services, baseline.services, (x) => x)) add('medium', `新增常駐服務 ${name}`)

  let status: CheckStatus = 'ok'
  if (findings.some((f) => f.severity === 'high')) status = 'bad'
  else if (findings.length > 0) status = 'warn'
  return { check: { status, summary: findings.length > 0 ? `新增 ${findings.length} 項` : '無變動' }, findings }
}
