// 注意：本檔會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。

export interface AuditSummary {
  supported: boolean
  counts: { low: number; moderate: number; high: number; critical: number }
  packages: Array<{ name: string; severity: string; title: string }>
}

const MAX_PACKAGES = 20
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, moderate: 2, low: 3 }
const rank = (s: string): number => (s in SEVERITY_RANK ? SEVERITY_RANK[s] : 4)

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 結構不符就 throw，不回傳全 0（避免把「讀不懂」誤報成「沒有漏洞」） */
function readCounts(json: unknown): AuditSummary['counts'] {
  if (!isObj(json) || !isObj(json.metadata) || !isObj(json.metadata.vulnerabilities)) {
    throw new Error('audit 輸出缺少 metadata.vulnerabilities')
  }
  const v = json.metadata.vulnerabilities
  const num = (k: string): number => {
    const n = v[k]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error(`audit 計數 ${k} 不是數字`)
    return n
  }
  return { low: num('low'), moderate: num('moderate'), high: num('high'), critical: num('critical') }
}

function finish(counts: AuditSummary['counts'], packages: AuditSummary['packages']): AuditSummary {
  const sorted = packages
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p.severity) - rank(b.p.severity) || a.i - b.i)
    .slice(0, MAX_PACKAGES)
    .map((x) => x.p)
  return { supported: true, counts, packages: sorted }
}

export function parsePnpmAudit(json: unknown): AuditSummary {
  const counts = readCounts(json)
  const packages: AuditSummary['packages'] = []
  const adv = (json as Obj).advisories
  if (isObj(adv)) {
    for (const a of Object.values(adv)) {
      if (!isObj(a) || typeof a.module_name !== 'string' || typeof a.severity !== 'string') continue
      packages.push({ name: a.module_name, severity: a.severity, title: typeof a.title === 'string' ? a.title : '' })
    }
  }
  return finish(counts, packages)
}

export function parseNpmAudit(json: unknown): AuditSummary {
  const counts = readCounts(json)
  const packages: AuditSummary['packages'] = []
  const vulns = (json as Obj).vulnerabilities
  if (isObj(vulns)) {
    for (const [name, v] of Object.entries(vulns)) {
      if (!isObj(v) || typeof v.severity !== 'string') continue
      const via = Array.isArray(v.via) ? v.via : []
      const first = via.find(isObj)
      packages.push({ name, severity: v.severity, title: first && typeof first.title === 'string' ? first.title : '' })
    }
  }
  return finish(counts, packages)
}

export function detectPackageManager(files: string[]): 'pnpm' | 'npm' | 'yarn' | null {
  const names = new Set(files.map((f) => f.split('/').pop() ?? f))
  if (names.has('pnpm-lock.yaml')) return 'pnpm'
  if (names.has('package-lock.json')) return 'npm'
  if (names.has('yarn.lock')) return 'yarn'
  return null
}
