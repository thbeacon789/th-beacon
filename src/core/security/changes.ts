import { FALLBACK_KEY, MAX_TITLE } from './constants.ts'
import { truncateToUtf16Length } from './text.ts'
import type { CheckStatus, Evaluation, Finding, Inventory, ScanKind } from './types.ts'

const RECOMMENDATION = '確認是否為團隊成員所為；若否，視為入侵跡象處理'

const clip = (title: string) => truncateToUtf16Length(title, MAX_TITLE)

export function pickBaseline<T extends { scannedAt: string; inventory: Inventory | null }>(history: T[]): Inventory | null {
  let best: T | null = null
  // 容器清單是後來才加入的欄位：窗內最舊的快照可能沒有它。此時改取「最舊且含容器清單」的那一筆補上，
  // 否則容器比較要等舊快照全部滑出窗外（七天）才會開始生效。
  let bestWithContainers: T | null = null
  for (const h of history) {
    if (h.inventory === null) continue
    if (best === null || h.scannedAt < best.scannedAt) best = h
    if (h.inventory.containers !== undefined && (bestWithContainers === null || h.scannedAt < bestWithContainers.scannedAt)) {
      bestWithContainers = h
    }
  }
  if (best === null || best.inventory === null) return null
  if (best.inventory.containers === undefined && bestWithContainers?.inventory?.containers !== undefined) {
    return { ...best.inventory, containers: bestWithContainers.inventory.containers }
  }
  return best.inventory
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
    findings.push({ check: 'changes', key: FALLBACK_KEY, severity, title, recommendation: RECOMMENDATION })

  const newAdmins = added(current.admins, baseline.admins, (x) => x)
  const newAdminSet = new Set(newAdmins)
  // 哨兵條目（收集端無法解析或無法逐一展開的項目）以雜湊比對，title 補上人看得懂的說明；嚴重度沿用該類別
  for (const name of newAdmins) {
    if (name.startsWith('?sudoers:')) add('high', `sudoers 出現無法解析或間接的授權設定（${name}）`)
    else if (name.startsWith('#')) add('high', `新增以 uid 授權的管理員 ${name}`)
    else if (name.startsWith('%')) add('high', `群組 ${name.slice(1)} 取得管理員權限`)
    else add('high', `新增管理員帳號 ${name}`)
  }
  for (const k of added(current.sshKeys, baseline.sshKeys, (x) => `${x.user}\0${x.fingerprint}`)) {
    if (k.user === '(sshd)') add('high', 'SSH 金鑰來源設定變更（AuthorizedKeysFile／AuthorizedKeysCommand／TrustedUserCAKeys）')
    else if (k.fingerprint.startsWith('UNPARSEABLE:')) add('high', `${k.user} 的授權金鑰檔出現無法解析的項目`)
    else add('high', `${k.user} 新增 SSH 金鑰 ${k.fingerprint}`)
  }
  // 基準的管理員帳號也算已知帳號：OS Login 帳號登入當下就寫進 sudoers，但 getent passwd
  // 要等本機快取刷新才列出，否則同一個舊帳號會在一兩天後被誤報為「新增帳號」。
  // 管理員清單的哨兵（?／#／% 開頭）不是帳號名，不納入，以免遮蔽同字面的真帳號。
  const knownUsers = [...baseline.users, ...baseline.admins.filter((x) => !/^[?#%]/.test(x))]
  for (const name of added(current.users, knownUsers, (x) => x)) {
    if (!newAdminSet.has(name)) add('medium', `新增帳號 ${name}`)
  }
  for (const s of added(current.scheduled, baseline.scheduled, (x) => `${x.location}\0${x.hash}`)) {
    if (s.location.startsWith('?path:') || s.location.startsWith('?unit:')) add('medium', `新增名稱異常的排程項目（${s.location}）`)
    else add('medium', `新增或變更排程 ${s.location}`)
  }
  for (const l of added(current.listeners, baseline.listeners, (x) => `${x.proto}\0${x.port}`)) {
    add('medium', `新增監聽埠 ${l.proto}/${l.port}（${l.process}）`)
  }
  for (const name of added(current.services, baseline.services, (x) => x)) add('medium', `新增常駐服務 ${name}`)

  // 容器：目前與基準都有清單才比較（舊基準沒有此欄位時，第一次帶上視為建立基準）。
  // 映像檔版本不列入（見 normalizeImage）；只標記新增，消失與 port 減少不報。
  if (current.containers !== undefined && baseline.containers !== undefined) {
    const baseByName = new Map(baseline.containers.map((c) => [c.name, c]))
    for (const c of current.containers) {
      const b = baseByName.get(c.name)
      if (!b) {
        add('medium', clip(`新增容器 ${c.name}（映像檔 ${c.image}）`))
        continue
      }
      if (b.image !== c.image) add('medium', clip(`容器 ${c.name} 的映像檔來源由 ${b.image} 變為 ${c.image}`))
      const basePorts = new Set(b.ports)
      for (const port of c.ports) if (!basePorts.has(port)) add('medium', clip(`容器 ${c.name} 新增對外埠對應 ${port}`))
    }
  }

  // 基準有容器、目前卻拿不到清單（docker 被移除或搬離預設路徑 → NONE）：不可無聲略過
  if (current.containers === undefined && baseline.containers !== undefined && baseline.containers.length > 0) {
    add('high', clip(`容器清單無法取得（先前有 ${baseline.containers.length} 個容器）；docker 可能已被移除或搬離預設路徑`))
  }

  let status: CheckStatus = 'ok'
  if (findings.some((f) => f.severity === 'high')) status = 'bad'
  else if (findings.length > 0) status = 'warn'
  return { check: { status, summary: findings.length > 0 ? `新增 ${findings.length} 項` : '無變動' }, findings }
}
