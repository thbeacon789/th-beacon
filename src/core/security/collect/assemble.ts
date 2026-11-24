// 注意：本檔會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。
import type {
  CertFact, CheckResult, Evaluation, ExposureFact, Finding, ImageDeps, Inventory, JudgedCheckKey, LogSourceVolume, ScanKind,
  SecurityScanPayload,
} from '../types.ts'
import { MAX_FINDINGS } from '../constants.ts'
import type { VmFacts } from './vm-dump.ts'

export interface Judgment { checks: Record<JudgedCheckKey, CheckResult>; findings: Finding[] }
export interface TargetConfig {
  service: string
  secretEnv: string
  kind: ScanKind
  domains: string[]
  expectedPublicPorts?: number[]
  changesIgnore?: { users?: string[] }
  logSources?: Array<{ name: string; type: 'file' | 'journal' | 'docker'; path?: string; unit?: string; container?: string }>
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
  deps?: { evaluation: Evaluation; images: ImageDeps[] }
}): SecurityScanPayload {
  const { scannedAt, target, judgment, certs, exposure, vm, deps } = args
  const payload: SecurityScanPayload = {
    scannedAt,
    kind: target.kind,
    checks: judgment.checks,
    findings: judgment.findings,
    certs,
    exposure,
  }
  if (target.kind === 'vm' && vm) {
    const volumes = vm.logVolume.map(stripVolume)
    // 設定的來源在收集結果中缺席（例如被 shell 端略過）：補成 error，不可讓它悄悄消失
    for (const s of target.logSources ?? []) {
      if (!volumes.some((v) => v.source === s.name)) volumes.push({ source: s.name, error: true })
    }
    payload.logVolume = volumes
    payload.inventory = applyChangesIgnore(vm.inventory, target.changesIgnore)
  }
  // deps 由排程端確定性計算，只有 vm 帶；hosted 即使傳入也不寫
  if (target.kind === 'vm' && deps) {
    payload.checks = { ...payload.checks, deps: deps.evaluation.check }
    // deps findings 優先保留：與判讀 findings 合計上限為 MAX_FINDINGS，超過整份快照會被驗證拒絕，
    // 所以截的是判讀 findings（模型輸出，可再產生），不是確定性的 deps findings。
    const depsFindings = deps.evaluation.findings.slice(0, MAX_FINDINGS)
    payload.findings = [...payload.findings.slice(0, MAX_FINDINGS - depsFindings.length), ...depsFindings]
    payload.deps = deps.images
  }
  return payload
}
