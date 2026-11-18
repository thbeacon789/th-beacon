import { describe, it, expect } from 'vitest'
import { publicListeners, type FirewallRule, type InstanceInfo } from '@/core/security/collect/firewall'

const inst: InstanceInfo = { network: 'https://www.googleapis.com/compute/v1/projects/p/global/networks/default', tags: ['web'], serviceAccounts: ['vm@p.iam.gserviceaccount.com'] }
const rule = (over: Partial<FirewallRule> = {}): FirewallRule => ({
  name: 'r', direction: 'INGRESS', network: 'projects/p/global/networks/default', sourceRanges: ['0.0.0.0/0'], allowed: [{ IPProtocol: 'tcp', ports: ['443'] }], ...over,
})
const l = (port: number, address = '0.0.0.0', proto: 'tcp' | 'udp' = 'tcp') => ({ proto, port, process: 'p', address })
const ports = (ls: ReturnType<typeof publicListeners>) => ls.map((x) => x.port)

describe('publicListeners', () => {
  it('允許的埠算對外，未開放的不算', () => {
    expect(publicListeners([l(443), l(80)], [rule()], inst)).toEqual([{ proto: 'tcp', port: 443, process: 'p' }])
  })

  it('loopback 監聽不算對外', () => {
    const ls = [l(443, '127.0.0.1'), l(443, '127.0.0.53'), l(443, '::1'), l(443, '[::1]')]
    expect(publicListeners(ls, [rule()], inst)).toEqual([])
  })

  it('規則未設 ports 代表全部埠', () => {
    expect(ports(publicListeners([l(1234)], [rule({ allowed: [{ IPProtocol: 'tcp' }] })], inst))).toEqual([1234])
  })

  it('規則 ports 為 "8000-8100" 時 8050 對外、8101 不對外', () => {
    const r = rule({ allowed: [{ IPProtocol: 'tcp', ports: ['8000-8100'] }] })
    expect(ports(publicListeners([l(8050), l(8101), l(7999)], [r], inst))).toEqual([8050])
  })

  it('IPProtocol 為 all 涵蓋 udp；不同協定不符', () => {
    expect(ports(publicListeners([l(53, '0.0.0.0', 'udp')], [rule({ allowed: [{ IPProtocol: 'all' }] })], inst))).toEqual([53])
    expect(publicListeners([l(53, '0.0.0.0', 'udp')], [rule()], inst)).toEqual([])
  })

  it('規則的 targetTags 與 instance 無交集時不適用，有交集則適用', () => {
    expect(publicListeners([l(443)], [rule({ targetTags: ['db'] })], inst)).toEqual([])
    expect(ports(publicListeners([l(443)], [rule({ targetTags: ['db', 'web'] })], inst))).toEqual([443])
    expect(publicListeners([l(443)], [rule({ targetServiceAccounts: ['other@x'] })], inst)).toEqual([])
    expect(ports(publicListeners([l(443)], [rule({ targetServiceAccounts: ['vm@p.iam.gserviceaccount.com'] })], inst))).toEqual([443])
  })

  it('disabled 的規則與 EGRESS 規則不適用', () => {
    expect(publicListeners([l(443)], [rule({ disabled: true })], inst)).toEqual([])
    expect(publicListeners([l(443)], [rule({ direction: 'EGRESS' })], inst)).toEqual([])
    expect(ports(publicListeners([l(443)], [rule({ direction: undefined })], inst))).toEqual([443])
  })

  it('來源不含 0.0.0.0/0 的規則不適用', () => {
    expect(publicListeners([l(443)], [rule({ sourceRanges: ['10.0.0.0/8'] })], inst)).toEqual([])
  })

  it('不同 network 的規則不適用', () => {
    expect(publicListeners([l(443)], [rule({ network: 'projects/p/global/networks/other' })], inst)).toEqual([])
  })

  it('同 proto+port 只回報一次', () => {
    expect(publicListeners([l(443), l(443, '::')], [rule()], inst)).toHaveLength(1)
  })

  it('規則缺 network 仍適用；instance.network 為空字串時規則仍適用', () => {
    expect(ports(publicListeners([l(443)], [rule({ network: undefined })], inst))).toEqual([443])
    expect(ports(publicListeners([l(443)], [rule({ network: '' })], inst))).toEqual([443])
    expect(ports(publicListeners([l(443)], [rule({ network: 'projects/p/global/networks/other' })], { ...inst, network: '' }))).toEqual([443])
  })
})
