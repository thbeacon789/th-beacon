// th-beacon 資安監控：runner 端掃描 CLI
// 用法：node scripts/security/scan.mts --target <service> [--dry-run <fixtureDir>]
// 以 Node 直接執行（type stripping）：只用相對路徑加 .ts 副檔名與 Node 內建模組。
// VM 輸出、audit JSON、HTTP 回應皆為不可信輸入：不拿來組指令、eval、動態 import、當路徑或當 RegExp。
// 日誌只印各 check 的狀態與筆數摘要，不印完整 payload，也不印任何秘密。
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { parseVmDump } from '../../src/core/security/collect/vm-dump.ts'
import type { VmFacts } from '../../src/core/security/collect/vm-dump.ts'
import { publicListeners } from '../../src/core/security/collect/firewall.ts'
import type { FirewallRule, InstanceInfo } from '../../src/core/security/collect/firewall.ts'
import { filterScannerLogins, summarizeLogins } from '../../src/core/security/collect/logins.ts'
import { detectPackageManager, parseNpmAudit, parsePnpmAudit } from '../../src/core/security/collect/audit.ts'
import type { AuditSummary } from '../../src/core/security/collect/audit.ts'
import { parseSecurityScanPayload } from '../../src/core/security/payload.ts'
import { assemblePayload, unknownJudgment } from '../../src/core/security/collect/assemble.ts'
import type { Judgment, TargetConfig } from '../../src/core/security/collect/assemble.ts'
import { evaluateDeps } from '../../src/core/security/deps.ts'
import { planImageScans } from '../../src/core/security/collect/images.ts'
import type { CertFact, CheckResult, Evaluation, ExposureFact, ImageDeps } from '../../src/core/security/types.ts'
import { auditEnv, prepareAuditDir } from './lib/audit-run.ts'
import { fetchCert, isValidDomain, probeDomain, probeLegacyTls } from './lib/external.ts'
import type { ExposurePath } from './lib/external.ts'
import { describeInstance, listFirewallRules, runVmCollector } from './lib/gcp.ts'
import { dockerOsvRunner, scanImages } from './lib/image-scan.ts'
import type { ImageScanRunner } from './lib/image-scan.ts'
import { judge } from './lib/judge.ts'
import type { JudgeResult } from './lib/judge.ts'
import { postSigned } from './lib/beacon.ts'

const here = import.meta.dirname
const DRY_NONCE = '0'.repeat(32)

class ExitError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const brief = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200)

interface ExternalResult { certs: CertFact[]; exposure: ExposureFact[]; incomplete: boolean }
type Probed = Awaited<ReturnType<typeof probeDomain>>

/** 任一設定的 domain 缺憑證或缺 exposure 事實即視為外部檢查不完整 */
function reportIncomplete(domains: string[], certs: CertFact[], exposure: ExposureFact[]): boolean {
  let incomplete = false
  for (const d of domains) {
    const missing: string[] = []
    if (!certs.some((c) => c.domain === d)) missing.push('憑證')
    if (!exposure.some((e) => e.domain === d)) missing.push('暴露面')
    if (missing.length > 0) {
      console.error(`外部檢查不完整：${d} 缺少${missing.join('、')}`)
      incomplete = true
    }
  }
  return incomplete
}

async function externalChecks(target: TargetConfig, dryDir: string | undefined): Promise<ExternalResult> {
  if (dryDir !== undefined) {
    const j = readJson(join(dryDir, 'external.json')) as { certs?: CertFact[]; exposure?: ExposureFact[] }
    const certs = j.certs ?? []
    const exposure = j.exposure ?? []
    return { certs, exposure, incomplete: reportIncomplete(target.domains, certs, exposure) }
  }
  const paths = readJson(join(here, '../../security/exposure-paths.json')) as ExposurePath[]
  const domains = target.domains.filter((d) => {
    if (isValidDomain(d)) return true
    console.warn('警告：略過格式不符的 domain')
    return false
  })
  const certs: CertFact[] = []
  const exposure: ExposureFact[] = []
  let probeErrors = 0
  await Promise.all(
    domains.map(async (domain) => {
      const [cert, probe, legacy] = await Promise.allSettled([
        fetchCert(domain), probeDomain(domain, paths), probeLegacyTls(domain),
      ])
      if (cert.status === 'fulfilled') certs.push(cert.value)
      if (probe.status === 'fulfilled') {
        const { probeErrors: failed, ...fact }: Probed = probe.value
        probeErrors += failed
        exposure.push({ ...fact, probeErrors: failed, legacyTls: legacy.status === 'fulfilled' ? legacy.value : null })
      }
    }),
  )
  // 格式不符而被略過的 domain 不在 certs／exposure 內，同樣會被判為不完整
  // 敏感路徑請求失敗（逾時、連線錯誤）無法證明沒有暴露，同樣視為外部檢查不完整
  if (probeErrors > 0) console.error(`外部檢查不完整：${probeErrors} 個敏感路徑請求失敗`)
  const incomplete = reportIncomplete(target.domains.filter(isValidDomain), certs, exposure)
  return { certs, exposure, incomplete: incomplete || domains.length !== target.domains.length || probeErrors > 0 }
}

interface VmCollected { vm: VmFacts; facts: unknown }

function collectVm(target: TargetConfig, dryDir: string | undefined): VmCollected {
  let vm: VmFacts
  let instance: InstanceInfo
  let rules: FirewallRule[]
  if (dryDir !== undefined) {
    vm = parseVmDump(readFileSync(join(dryDir, 'vm-dump.txt'), 'utf8'), DRY_NONCE)
    instance = readJson(join(dryDir, 'instance.json')) as InstanceInfo
    rules = readJson(join(dryDir, 'firewall.json')) as FirewallRule[]
  } else {
    const { GCP_PROJECT: project, GCP_ZONE: zone, GCP_INSTANCE: inst } = process.env
    if (!project || !zone || !inst) throw new ExitError(2, '缺少 GCP_PROJECT／GCP_ZONE／GCP_INSTANCE')
    const gcp = { project, zone, instance: inst }
    const nonce = randomBytes(16).toString('hex')
    const dump = runVmCollector(gcp, join(here, 'collect-vm.sh'), nonce, target.logSources)
    vm = parseVmDump(dump, nonce)
    instance = describeInstance(gcp)
    rules = listFirewallRules(project)
  }
  if (vm.missingSections.length > 0) {
    throw new ExitError(1, `VM 收集缺漏區段：${vm.missingSections.join(', ')}`)
  }
  const ports = publicListeners(vm.listeners, rules, instance)
  // 只送摘要，不送 authLines 原始行；掃描器自己的例行登入先濾掉，並告知模型濾掉幾筆
  const { summary: logins, ignoredScannerLogins } = filterScannerLogins(summarizeLogins(vm.authLines), target.changesIgnore?.users)
  console.log(`收集完成：對外埠 ${ports.length}、可更新 ${vm.updates.upgradable}、登入失敗 ${logins.failed}`)
  return {
    vm,
    facts: {
      publicPorts: ports,
      expectedPublicPorts: target.expectedPublicPorts ?? [],
      updates: vm.updates,
      ssh: vm.ssh,
      logins,
      ignoredScannerLogins,
    },
  }
}

type AuditOutcome =
  | { kind: 'ok'; audit: AuditSummary }
  | { kind: 'unsupported' }
  | { kind: 'failed'; reason: string }

function collectAudit(dryDir: string | undefined): AuditOutcome {
  try {
    if (dryDir !== undefined) return { kind: 'ok', audit: parsePnpmAudit(readJson(join(dryDir, 'audit.json'))) }
    const dir = process.env.TARGET_REPO_DIR
    if (!dir) return { kind: 'failed', reason: 'TARGET_REPO_DIR 未設定' }
    const pm = detectPackageManager(readdirSync(dir))
    if (pm !== 'pnpm' && pm !== 'npm') return { kind: 'unsupported' }
    // 有漏洞時 audit 的 exit code 非 0 屬正常，以 stdout 的 JSON 為準；不安裝相依套件。
    // 在只含 package.json 與 lockfile 的暫存目錄執行，且子行程只拿最小環境（見 lib/audit-run.ts）
    const tmp = prepareAuditDir(dir, pm)
    try {
      const r = spawnSync(pm, pm === 'pnpm' ? ['audit', '--json'] : ['audit', '--json', '--package-lock-only'], {
        cwd: tmp, env: auditEnv(process.env), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000,
      })
      if (r.error) return { kind: 'failed', reason: `${pm} audit 無法執行或逾時` }
      const json = JSON.parse(r.stdout) as unknown
      return { kind: 'ok', audit: pm === 'pnpm' ? parsePnpmAudit(json) : parseNpmAudit(json) }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } catch (e) {
    return { kind: 'failed', reason: brief(e) }
  }
}

const IMAGE_SCAN_TIMEOUT_MS = 5 * 60 * 1000
const DIGEST_REF_RE = /@sha256:([a-f0-9]{64})$/

interface DepsOutcome { evaluation: Evaluation; images: ImageDeps[]; failed: number }

/** dry-run 的讀檔 runner：<dryDir>/osv/<digest 的 hex>.json */
function fixtureRunner(dryDir: string): ImageScanRunner {
  return (ref) => {
    const m = DIGEST_REF_RE.exec(ref)
    if (!m) return { ok: false, reason: 'fixture 不存在' }
    try {
      return { ok: true, json: readJson(join(dryDir, 'osv', `${m[1]}.json`)) }
    } catch {
      return { ok: false, reason: 'fixture 不存在' }
    }
  }
}

function collectDeps(vm: VmFacts, dryDir: string | undefined): DepsOutcome {
  const { entries, failed } = vm.images
  if (failed) {
    console.error('映像檔清單收集失敗，deps 判 unknown')
    return { evaluation: evaluateDeps({ failed: true }), images: [], failed: 1 }
  }
  if (entries === undefined) return { evaluation: evaluateDeps({ none: true }), images: [], failed: 0 }
  const runner = dryDir !== undefined
    ? fixtureRunner(dryDir)
    : dockerOsvRunner({ osvBin: process.env.OSV_SCANNER_BIN || 'osv-scanner', timeoutMs: IMAGE_SCAN_TIMEOUT_MS, env: process.env })
  const images = scanImages(planImageScans(entries), runner)
  const failedCount = images.filter((i) => i.error !== undefined).length
  console.log(`套件掃描：映像檔 ${images.length}、失敗 ${failedCount}`)
  return { evaluation: evaluateDeps({ images }), images, failed: failedCount }
}

function dryJudgment(dryDir: string): JudgeResult {
  const j = readJson(join(dryDir, 'judgment.json')) as Judgment & { usage?: JudgeResult['usage'] }
  return { judgment: { checks: j.checks, findings: j.findings }, usage: j.usage ?? null }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { target: { type: 'string' }, 'dry-run': { type: 'string' } },
    strict: true,
  })
  const service = values.target
  const dryDir = values['dry-run']
  if (!service) throw new ExitError(2, '用法：scan.mts --target <service> [--dry-run <fixtureDir>]')

  const targetsFile = process.env.SECURITY_TARGETS_FILE || join(here, '../../security/targets.json')
  const targets = readJson(targetsFile) as TargetConfig[]
  const target = Array.isArray(targets) ? targets.find((t) => t.service === service) : undefined
  if (!target) throw new ExitError(2, `找不到目標：${service}`)

  const beaconUrl = (process.env.BEACON_URL ?? '').replace(/\/+$/, '')
  const secret = process.env.BEACON_SECRET ?? ''
  if (!beaconUrl || !secret) throw new ExitError(2, '缺少 BEACON_URL 或 BEACON_SECRET')

  if (target.kind === 'vm' && dryDir === undefined && (!process.env.GCP_PROJECT || !process.env.GCP_ZONE || !process.env.GCP_INSTANCE)) {
    throw new ExitError(2, '缺少 GCP_PROJECT／GCP_ZONE／GCP_INSTANCE')
  }

  const scannedAt = new Date().toISOString()
  const { certs, exposure, incomplete } = await externalChecks(target, dryDir)
  console.log(`外部檢查：憑證 ${certs.length}、暴露面 ${exposure.length}`)

  let vm: VmFacts | undefined
  let facts: unknown
  let auditNote: string | null = null // 非 null 表示不呼叫判讀，updates 直接填 unknown
  let auditFailed = false
  if (target.kind === 'vm') {
    try {
      const c = collectVm(target, dryDir)
      vm = c.vm
      facts = c.facts
    } catch (e) {
      if (e instanceof ExitError) throw e
      throw new ExitError(1, `收集失敗：${brief(e)}`)
    }
  } else {
    const outcome = collectAudit(dryDir)
    if (outcome.kind === 'ok') facts = { audit: outcome.audit }
    else if (outcome.kind === 'unsupported') auditNote = '不支援的套件管理器'
    else {
      console.error(`相依套件稽核失敗：${outcome.reason}`)
      auditNote = '相依套件稽核失敗'
      auditFailed = true
    }
  }

  let judgment: Judgment
  let usage: JudgeResult['usage'] = null
  let judgeFailed = false
  if (auditNote !== null) {
    judgment = unknownJudgment('hosted')
    judgment.checks.updates = { status: 'unknown', summary: auditNote }
  } else {
    try {
      const r = dryDir !== undefined ? dryJudgment(dryDir) : await judge(facts, target.kind, process.env)
      judgment = r.judgment
      usage = r.usage
    } catch (e) {
      console.error(`判讀失敗：${brief(e)}`)
      judgment = unknownJudgment(target.kind)
      judgeFailed = true
    }
  }
  const line = (k: 'ports' | 'updates' | 'logins'): string => {
    const c: CheckResult = judgment.checks[k]
    return `${k}=${c.status}`
  }
  console.log(`判讀：${line('ports')} ${line('updates')} ${line('logins')}，發現 ${judgment.findings.length} 筆`)

  // 推送前先用伺服端同一套驗證檢查：模型輸出的邊界情況（如空白 title）不可讓整筆快照
  // （含憑證與暴露面事實）一起被 422 丟掉。
  // deps 只有 vm 帶：由排程端逐一拉取並掃描映像檔，確定性判燈（不經 Claude）
  const depsOutcome = vm ? collectDeps(vm, dryDir) : undefined
  const deps = depsOutcome && { evaluation: depsOutcome.evaluation, images: depsOutcome.images }
  const depsFailed = (depsOutcome?.failed ?? 0) > 0
  let payload = assemblePayload({ scannedAt, target, judgment, certs, exposure, vm, deps })
  let check = parseSecurityScanPayload(payload, new Date())
  if (!check.ok && auditNote === null && !judgeFailed) {
    console.error(`判讀輸出未通過驗證，改用 unknown：${check.errors.slice(0, 5).join('；')}`)
    judgment = unknownJudgment(target.kind)
    judgeFailed = true
    payload = assemblePayload({ scannedAt, target, judgment, certs, exposure, vm, deps })
    check = parseSecurityScanPayload(payload, new Date())
  }
  if (!check.ok) {
    throw new ExitError(1, `payload 驗證失敗，不推送：${check.errors.join('；')}`)
  }
  const scan = await postSigned(`${beaconUrl}/api/security-scan`, service, secret, payload)
  if (scan.status !== 200 && scan.status !== 201) {
    throw new ExitError(1, `推送快照失敗：HTTP ${scan.status} ${scan.body}`)
  }
  console.log(`快照已推送：HTTP ${scan.status}`)

  if (usage) {
    try {
      const u = await postSigned(`${beaconUrl}/api/ai-usage`, service, secret, {
        source: 'ci_security', model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      })
      console.log(`AI 用量回報：HTTP ${u.status}`)
    } catch (e) {
      console.warn(`AI 用量回報失敗：${brief(e)}`)
    }
  }
  if (incomplete) console.error('外部檢查不完整，快照已推送但回報失敗')
  return judgeFailed || incomplete || auditFailed || depsFailed ? 1 : 0
}

main().then(
  (code) => { process.exitCode = code },
  (e) => {
    const code = e instanceof ExitError ? e.code : 1
    console.error(e instanceof ExitError ? e.message : `未預期錯誤：${brief(e)}`)
    process.exitCode = code
  },
)
