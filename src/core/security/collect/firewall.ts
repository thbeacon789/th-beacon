// 注意：本檔會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。
import type { Listener } from '../types.ts'

export interface FirewallRule {
  name: string
  direction?: string
  disabled?: boolean
  network?: string
  sourceRanges?: string[]
  targetTags?: string[]
  targetServiceAccounts?: string[]
  allowed?: Array<{ IPProtocol: string; ports?: string[] }>
}
export interface InstanceInfo { network: string; tags: string[]; serviceAccounts: string[] }

const lastSegment = (url: string): string => url.split('/').filter((s) => s.length > 0).pop() ?? ''

function isLoopback(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a) || a === '::1'
}

function intersects(a: string[], b: string[]): boolean {
  return a.some((x) => b.includes(x))
}

function ruleApplies(rule: FirewallRule, instance: InstanceInfo): boolean {
  if (rule.direction !== undefined && rule.direction !== 'INGRESS') return false
  if (rule.disabled === true) return false
  if (!rule.sourceRanges?.includes('0.0.0.0/0')) return false
  if (rule.network === undefined || lastSegment(rule.network) !== lastSegment(instance.network)) return false
  const tags = rule.targetTags ?? []
  const accounts = rule.targetServiceAccounts ?? []
  if (tags.length === 0 && accounts.length === 0) return true
  return intersects(tags, instance.tags) || intersects(accounts, instance.serviceAccounts)
}

function portAllowed(ports: string[] | undefined, port: number): boolean {
  if (ports === undefined) return true
  return ports.some((p) => {
    const range = /^(\d{1,5})-(\d{1,5})$/.exec(p)
    if (range) return port >= Number(range[1]) && port <= Number(range[2])
    return /^\d{1,5}$/.test(p) && Number(p) === port
  })
}

/**
 * 判斷哪些監聽實際對外（非 loopback，且有適用的 INGRESS 允許規則）。
 * 不處理 deny 規則與優先序：寧可多報，不可漏報。
 */
export function publicListeners(
  listeners: Array<Listener & { address: string }>,
  rules: FirewallRule[],
  instance: InstanceInfo,
): Listener[] {
  const applicable = rules.filter((r) => ruleApplies(r, instance))
  const out: Listener[] = []
  const seen = new Set<string>()
  for (const l of listeners) {
    if (isLoopback(l.address)) continue
    const open = applicable.some((r) =>
      (r.allowed ?? []).some((a) => {
        const p = a.IPProtocol.toLowerCase()
        return (p === 'all' || p === l.proto) && portAllowed(a.ports, l.port)
      }),
    )
    if (!open) continue
    const key = `${l.proto}|${l.port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ proto: l.proto, port: l.port, process: l.process })
  }
  return out
}
