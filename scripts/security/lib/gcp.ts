// 注意：本檔以 Node 直接執行（type stripping）。只用相對路徑加 .ts 副檔名與 Node 內建模組。
// gcloud 一律以參數陣列呼叫，不經 shell。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { FirewallRule, InstanceInfo } from '../../../src/core/security/collect/firewall.ts'
import type { TargetConfig } from '../../../src/core/security/collect/assemble.ts'

export interface GcpTarget { project: string; zone: string; instance: string }

const NONCE_RE = /^[a-f0-9]{32}$/
const SAFE_RE = /^[A-Za-z0-9_.@/-]+$/
const MAX_BUFFER = 64 * 1024 * 1024
const COLLECT_TIMEOUT_MS = 5 * 60 * 1000
const API_TIMEOUT_MS = 2 * 60 * 1000

function gcloud(args: string[], timeout: number): string {
  return execFileSync('gcloud', args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const check = (what: string, v: string): void => {
  if (!SAFE_RE.test(v)) throw new Error(`${what} 含不允許的字元`)
}

// 與 scripts/security/collect-vm.sh 的驗證規則完全一致：設定錯誤要在這裡大聲失敗，不要到 shell 端被靜默略過
const LOG_NAME_RE = /^[A-Za-z0-9_.-]+$/
const LOG_PATH_RE = /^[A-Za-z0-9_.@/-]+$/
const LOG_UNIT_RE = /^[A-Za-z0-9_.@-]+$/

const GCP_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i

/** 以 - 開頭的值會被 gcloud 當成旗標，故三個欄位都須通過驗證 */
export function validateGcpTarget(target: GcpTarget): void {
  for (const k of ['project', 'zone', 'instance'] as const) {
    if (typeof target[k] !== 'string' || !GCP_NAME_RE.test(target[k])) throw new Error(`GCP ${k} 格式不合法`)
  }
}

/** 組出遠端指令；除固定字面值外只會出現 base64 字元與 hex nonce。不合法即 throw。 */
export function buildRemoteCommand(
  scriptContent: string,
  nonce: string,
  logSources: TargetConfig['logSources'],
): string {
  if (!NONCE_RE.test(nonce)) throw new Error('nonce 格式不符')
  const lines: string[] = []
  const seen = new Set<string>()
  for (const s of logSources ?? []) {
    const value = s.type === 'file' ? s.path : s.type === 'journal' ? s.unit : undefined
    if (value === undefined) throw new Error('logSources 缺少 path 或 unit')
    check('logSources.name', s.name)
    check('logSources.target', value)
    if (!LOG_NAME_RE.test(s.name)) throw new Error('logSources.name 格式不符')
    if (s.type === 'file') {
      if (!value.startsWith('/') || !LOG_PATH_RE.test(value)) throw new Error('logSources.path 須以 / 開頭且只含 A-Za-z0-9_.@/-')
    } else if (!LOG_UNIT_RE.test(value) || value.startsWith('-')) {
      throw new Error('logSources.unit 只可含 A-Za-z0-9_.@-，且不可以 - 開頭')
    }
    if (seen.has(s.name)) throw new Error(`logSources.name 重複：${s.name}`)
    seen.add(s.name)
    lines.push(`${s.name}\t${s.type}\t${value}`)
  }
  const scriptB64 = Buffer.from(scriptContent).toString('base64')
  const sourcesB64 = Buffer.from(lines.join('\n') + (lines.length > 0 ? '\n' : '')).toString('base64')
  return `echo ${scriptB64} | base64 -d | sudo BEACON_NONCE=${nonce} BEACON_LOG_SOURCES_B64=${sourcesB64} bash`
}

export function runVmCollector(
  target: GcpTarget,
  scriptPath: string,
  nonce: string,
  logSources: TargetConfig['logSources'],
): string {
  validateGcpTarget(target)
  const remote = buildRemoteCommand(readFileSync(scriptPath, 'utf8'), nonce, logSources)
  return gcloud(
    [
      'compute', 'ssh', target.instance,
      `--project=${target.project}`, `--zone=${target.zone}`,
      '--tunnel-through-iap', '--quiet', '--strict-host-key-checking=no',
      `--command=${remote}`,
    ],
    COLLECT_TIMEOUT_MS,
  )
}

export function describeInstance(target: GcpTarget): InstanceInfo {
  validateGcpTarget(target)
  const out = gcloud(
    [
      'compute', 'instances', 'describe', target.instance,
      `--project=${target.project}`, `--zone=${target.zone}`, '--format=json',
    ],
    API_TIMEOUT_MS,
  )
  const j = JSON.parse(out) as {
    networkInterfaces?: Array<{ network?: string }>
    tags?: { items?: string[] }
    serviceAccounts?: Array<{ email?: string }>
  }
  return {
    network: j.networkInterfaces?.[0]?.network ?? '',
    tags: j.tags?.items ?? [],
    serviceAccounts: (j.serviceAccounts ?? []).map((a) => a.email ?? '').filter((e) => e !== ''),
  }
}

export function listFirewallRules(project: string): FirewallRule[] {
  if (!GCP_NAME_RE.test(project)) throw new Error('GCP project 格式不合法')
  const out = gcloud(['compute', 'firewall-rules', 'list', `--project=${project}`, '--format=json'], API_TIMEOUT_MS)
  const j = JSON.parse(out) as unknown
  if (!Array.isArray(j)) throw new Error('防火牆規則輸出不是陣列')
  return j as FirewallRule[]
}
