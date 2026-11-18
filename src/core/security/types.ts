// 注意：本目錄會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export type CheckStatus = 'ok' | 'warn' | 'bad' | 'unknown' | 'na'
export type JudgedCheckKey = 'ports' | 'updates' | 'logins'
export type ComputedCheckKey = 'logVolume' | 'exposure' | 'changes'
export type CheckKey = JudgedCheckKey | ComputedCheckKey | 'cert'
export type FindingSeverity = 'high' | 'medium' | 'low'
export type ScanKind = 'vm' | 'hosted'

export interface CheckResult { status: CheckStatus; summary: string }
export interface Finding { check: CheckKey; severity: FindingSeverity; title: string; recommendation: string }
export interface CertFact { domain: string; notAfter: string }
export interface HourCount { hour: string; count: number } // hour 為 UTC 整點 ISO
export interface LogSourceVolume { source: string; hourly?: HourCount[]; error?: true; anomalousHours?: string[] }
export interface ExposureHeaders { hsts: boolean; contentTypeOptions: boolean; frameProtection: boolean; csp: boolean; referrerPolicy: boolean }
export interface ExposureFact { domain: string; sensitivePaths: Array<{ path: string; exposed: boolean }>; headers: ExposureHeaders; legacyTls: boolean | null }
export interface ScheduledEntry { location: string; schedule: string; executable: string; hash: string }
export interface Listener { proto: 'tcp' | 'udp'; port: number; process: string }
export interface Inventory { users: string[]; admins: string[]; sshKeys: Array<{ user: string; fingerprint: string }>; scheduled: ScheduledEntry[]; listeners: Listener[]; services: string[] }

export interface SecurityScanPayload {
  scannedAt: string
  kind: ScanKind
  checks: Record<JudgedCheckKey, CheckResult>
  findings: Finding[] // check 只允許 JudgedCheckKey
  certs: CertFact[]
  exposure: ExposureFact[]
  logVolume?: LogSourceVolume[] // 不含 anomalousHours
  inventory?: Inventory
}
