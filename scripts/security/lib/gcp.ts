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

export function runVmCollector(
  target: GcpTarget,
  scriptPath: string,
  nonce: string,
  logSources: TargetConfig['logSources'],
): string {
  if (!NONCE_RE.test(nonce)) throw new Error('nonce 格式不符')
  const lines: string[] = []
  for (const s of logSources ?? []) {
    const value = s.type === 'file' ? s.path : s.unit
    if (value === undefined) throw new Error('logSources 缺少 path 或 unit')
    check('logSources.name', s.name)
    check('logSources.target', value)
    lines.push(`${s.name}\t${s.type}\t${value}`)
  }
  const scriptB64 = Buffer.from(readFileSync(scriptPath)).toString('base64')
  const sourcesB64 = Buffer.from(lines.join('\n') + (lines.length > 0 ? '\n' : '')).toString('base64')
  const remote = `echo ${scriptB64} | base64 -d | sudo BEACON_NONCE=${nonce} BEACON_LOG_SOURCES_B64=${sourcesB64} bash`
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
  const out = gcloud(['compute', 'firewall-rules', 'list', `--project=${project}`, '--format=json'], API_TIMEOUT_MS)
  const j = JSON.parse(out) as unknown
  if (!Array.isArray(j)) throw new Error('防火牆規則輸出不是陣列')
  return j as FirewallRule[]
}
