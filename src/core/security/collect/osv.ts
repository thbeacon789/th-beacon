// 注意：本檔會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。
import type { DepCounts, DepPackage, DepSeverity, ImageScanSummary } from '../types.ts'

export const MAX_DEP_PACKAGES = 20
export const MAX_DEP_IDS = 5
/** 與 payload 驗證的欄位上限一致（payload.ts MAX_DEP_FIELD）：超過會讓整份快照被拒 */
const MAX_FIELD = 300
/** payload 驗證會先 trim，所以這裡也先 trim 再截斷 */
const clip = (s: string): string => s.trim().slice(0, MAX_FIELD)

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const ORDER: DepSeverity[] = ['critical', 'high', 'moderate', 'low', 'unscored']
const rank = (s: DepSeverity): number => ORDER.indexOf(s)
const GHSA: Record<string, DepSeverity> = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'moderate', LOW: 'low' }

/** CVSS 分數字串換算等級；空字串、無法解析或 0 → unscored */
function fromCvss(s: unknown): DepSeverity {
  if (typeof s !== 'string' || s.trim() === '') return 'unscored'
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return 'unscored'
  if (n >= 9.0) return 'critical'
  if (n >= 7.0) return 'high'
  if (n >= 4.0) return 'moderate'
  return 'low'
}

/** 組內 GHSA 標籤取最高；沒有就退回 max_severity */
function groupSeverity(group: Obj, vulns: Obj[]): DepSeverity {
  const ids = new Set(Array.isArray(group.ids) ? group.ids.filter((i): i is string => typeof i === 'string') : [])
  let best: DepSeverity | null = null
  for (const v of vulns) {
    if (typeof v.id !== 'string' || !ids.has(v.id)) continue
    const label = isObj(v.database_specific) ? v.database_specific.severity : undefined
    const sev = typeof label === 'string' ? GHSA[label.toUpperCase()] : undefined
    if (sev && (best === null || rank(sev) < rank(best))) best = sev
  }
  return best ?? fromCvss(group.max_severity)
}

/** 結構不符就 throw，不回傳全 0（避免把「讀不懂」誤報成「沒有漏洞」） */
export function parseOsvImageScan(json: unknown): ImageScanSummary {
  if (!isObj(json) || !Array.isArray(json.results)) throw new Error('osv 輸出缺少 results 陣列')
  const counts: DepCounts = { critical: 0, high: 0, moderate: 0, low: 0, unscored: 0 }
  const seenGroups = new Set<string>()
  const pkgs = new Map<string, DepPackage>()

  for (const result of json.results) {
    if (!isObj(result)) throw new Error('osv results 項目不是物件')
    const list = result.packages ?? []
    if (!Array.isArray(list)) throw new Error('osv packages 不是陣列')
    for (const entry of list) {
      if (!isObj(entry) || !isObj(entry.package)) throw new Error('osv package 結構不符')
      const { name: rawName, version: rawVersion, ecosystem: rawEco } = entry.package
      if (typeof rawName !== 'string' || typeof rawVersion !== 'string' || typeof rawEco !== 'string') {
        throw new Error('osv package 缺少 name／version／ecosystem')
      }
      // 淨化成 payload 可接受的形狀：過長截斷；任一欄為空字串的 package 仍計入 counts，但不列入 packages
      const name = clip(rawName)
      const version = clip(rawVersion)
      const ecosystem = clip(rawEco)
      const listable = name !== '' && version !== '' && ecosystem !== ''
      const vulns = (Array.isArray(entry.vulnerabilities) ? entry.vulnerabilities : []).filter(isObj)
      const groups = Array.isArray(entry.groups) ? entry.groups.filter(isObj) : []
      const pkgKey = `${ecosystem}|${name}|${version}`
      for (const g of groups) {
        const ids = Array.isArray(g.ids) ? g.ids.filter((i): i is string => typeof i === 'string') : []
        const severity = groupSeverity(g, vulns)
        const groupKey = `${pkgKey}|${[...ids].sort().join(',')}`
        if (!seenGroups.has(groupKey)) {
          seenGroups.add(groupKey)
          counts[severity] += 1
        }
        if (!listable) continue
        const cur = pkgs.get(pkgKey) ?? { name, version, ecosystem, severity, ids: [] }
        if (rank(severity) < rank(cur.severity)) cur.severity = severity
        const firstId = ids[0] === undefined ? '' : clip(ids[0])
        if (firstId !== '' && !cur.ids.includes(firstId) && cur.ids.length < MAX_DEP_IDS) cur.ids.push(firstId)
        pkgs.set(pkgKey, cur)
      }
    }
  }

  const packages = [...pkgs.values()]
    .sort((a, b) => rank(a.severity) - rank(b.severity) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_DEP_PACKAGES)
  return { counts, packages }
}
