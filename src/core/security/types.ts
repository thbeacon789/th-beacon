// 注意：本目錄會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export type CheckStatus = 'ok' | 'warn' | 'bad' | 'unknown' | 'na'
export type JudgedCheckKey = 'ports' | 'updates' | 'logins'
export type ComputedCheckKey = 'logVolume' | 'exposure' | 'changes'
export type RunnerCheckKey = 'deps'
export type CheckKey = JudgedCheckKey | ComputedCheckKey | RunnerCheckKey | 'cert'
export type FindingSeverity = 'high' | 'medium' | 'low'
export type ScanKind = 'vm' | 'hosted'

export interface CheckResult { status: CheckStatus; summary: string }
export interface Finding { check: CheckKey; key: string; keyFallback?: true; severity: FindingSeverity; title: string; recommendation: string }
export interface CertFact { domain: string; notAfter: string; trusted?: boolean; error?: string }
export interface HourCount { hour: string; count: number } // hour 為 UTC 整點 ISO
export interface LogSourceVolume { source: string; hourly?: HourCount[]; error?: true; anomalousHours?: string[] }
export interface ExposureHeaders { hsts: boolean; contentTypeOptions: boolean; frameProtection: boolean; csp: boolean; referrerPolicy: boolean }
export interface ExposureFact { domain: string; sensitivePaths: Array<{ path: string; exposed: boolean }>; headers: ExposureHeaders; legacyTls: boolean | null; probeErrors?: number }
export interface ScheduledEntry { location: string; schedule: string; executable: string; hash: string }
export interface Listener { proto: 'tcp' | 'udp'; port: number; process: string }
/** 執行中的容器；image 不含版本，ports 只含發佈到主機的對應 */
export interface ContainerEntry { name: string; image: string; ports: string[] }
/** 執行中容器對應的映像檔；repoDigests 為本機映像檔記錄的 repo@sha256:… 清單（可為空）。imageId 為 '' 表示該容器的映像檔無法查詢（收集失敗的哨兵） */
export interface ImageEntry { container: string; configImage: string; imageId: string; repoDigests: string[] }
export interface Inventory {
  users: string[]
  admins: string[]
  sshKeys: Array<{ user: string; fingerprint: string }>
  scheduled: ScheduledEntry[]
  listeners: Listener[]
  services: string[]
  /** 選填：舊快照與沒有 Docker 的機器沒有此欄位 */
  containers?: ContainerEntry[]
}

export interface SecurityScanPayload {
  scannedAt: string
  kind: ScanKind
  checks: Record<JudgedCheckKey, CheckResult> & { deps?: CheckResult } // deps 只有 vm 帶
  findings: Finding[] // check 只允許 JudgedCheckKey 與 deps
  certs: CertFact[]
  exposure: ExposureFact[]
  logVolume?: LogSourceVolume[] // 不含 anomalousHours
  inventory?: Inventory
  deps?: ImageDeps[] // 只有 vm 帶
}

export interface Evaluation { check: CheckResult; findings: Finding[] }

/** 映像檔相依套件漏洞（osv-scanner）的嚴重度；unscored＝來源沒有給等級 */
export type DepSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'unscored'
export interface DepCounts { critical: number; high: number; moderate: number; low: number; unscored: number }
export interface DepPackage { name: string; version: string; ecosystem: string; severity: DepSeverity; ids: string[] }
export interface ImageScanSummary { counts: DepCounts; packages: DepPackage[] }
/** 每個映像檔的掃描結果；image 不含 digest；error 存在代表掃描失敗（此時無 counts／packages） */
export interface ImageDeps {
  image: string
  digest: string | null
  containers: string[]
  error?: string
  counts?: DepCounts
  packages?: DepPackage[]
}
