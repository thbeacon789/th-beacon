// 注意：本檔會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。
import type {
  CertFact, CheckResult, ExposureFact, Finding, Inventory, JudgedCheckKey, LogSourceVolume, ScanKind,
  SecurityScanPayload,
} from '../types.ts'
import type { VmFacts } from './vm-dump.ts'

export interface Judgment { checks: Record<JudgedCheckKey, CheckResult>; findings: Finding[] }
export interface TargetConfig {
  service: string
  secretEnv: string
  kind: ScanKind
  domains: string[]
  expectedPublicPorts?: number[]
  changesIgnore?: { users?: string[] }
  logSources?: Array<{ name: string; type: 'file' | 'journal'; path?: string; unit?: string }>
  repo?: string
}

export function applyChangesIgnore(inventory: Inventory, ignore: TargetConfig['changesIgnore']): Inventory {
  const users = new Set(ignore?.users ?? [])
  if (users.size === 0) return inventory
  return {
    ...inventory,
    users: inventory.users.filter((u) => !users.has(u)),
    admins: inventory.admins.filter((u) => !users.has(u)),
    sshKeys: inventory.sshKeys.filter((k) => !users.has(k.user)),
  }
}

export function unknownJudgment(kind: ScanKind): Judgment {
  const unknown: CheckResult = { status: 'unknown', summary: '判讀失敗，無法評估' }
  const na: CheckResult = { status: 'na', summary: '' }
  return {
    checks: { ports: kind === 'hosted' ? na : unknown, updates: unknown, logins: kind === 'hosted' ? na : unknown },
    findings: [],
  }
}

/** payload 的 logVolume 不含 anomalousHours（由伺服端計算） */
function stripVolume(v: LogSourceVolume): LogSourceVolume {
  return v.error ? { source: v.source, error: true } : { source: v.source, hourly: v.hourly ?? [] }
}

export function assemblePayload(args: {
  scannedAt: string
  target: TargetConfig
  judgment: Judgment
  certs: CertFact[]
  exposure: ExposureFact[]
  vm?: VmFacts
}): SecurityScanPayload {
  const { scannedAt, target, judgment, certs, exposure, vm } = args
  const payload: SecurityScanPayload = {
    scannedAt,
    kind: target.kind,
    checks: judgment.checks,
    findings: judgment.findings,
    certs,
    exposure,
  }
  if (target.kind === 'vm' && vm) {
    payload.logVolume = vm.logVolume.map(stripVolume)
    payload.inventory = applyChangesIgnore(vm.inventory, target.changesIgnore)
  }
  return payload
}
