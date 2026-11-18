import { describe, it, expect } from 'vitest'
import { evaluateChanges, pickBaseline } from '@/core/security/changes'
import type { Inventory } from '@/core/security/types'

function inv(over: Partial<Inventory> = {}): Inventory {
  return { users: ['alice'], admins: ['alice'], sshKeys: [], scheduled: [], listeners: [], services: [], ...over }
}
const REC = '確認是否為團隊成員所為；若否，視為入侵跡象處理'

describe('pickBaseline', () => {
  it('跳過 inventory 為 null 的快照並取最早者', () => {
    const a = inv({ users: ['a'] })
    const b = inv({ users: ['b'] })
    const r = pickBaseline([
      { scannedAt: '2026-11-17T00:00:00.000Z', inventory: b },
      { scannedAt: '2026-11-10T00:00:00.000Z', inventory: null },
      { scannedAt: '2026-11-12T00:00:00.000Z', inventory: a },
    ])
    expect(r).toBe(a)
  })
  it('沒有可用快照回 null', () => {
    expect(pickBaseline([])).toBeNull()
    expect(pickBaseline([{ scannedAt: '2026-11-10T00:00:00.000Z', inventory: null }])).toBeNull()
  })
})

describe('evaluateChanges 哨兵條目的說明', () => {
  const titles = (cur: Inventory) => evaluateChanges('vm', cur, inv()).findings.map((f) => [f.severity, f.title])
  it('admins 的 ?sudoers:／#uid／%群組', () => {
    expect(titles(inv({ admins: ['alice', '?sudoers:0123456789abcdef'] }))).toEqual([
      ['high', 'sudoers 出現無法解析或間接的授權設定（?sudoers:0123456789abcdef）'],
    ])
    expect(titles(inv({ admins: ['alice', '#1000'] }))).toEqual([['high', '新增以 uid 授權的管理員 #1000']])
    expect(titles(inv({ admins: ['alice', '%wheel'] }))).toEqual([['high', '群組 wheel 取得管理員權限']])
  })
  it('sshKeys 的 UNPARSEABLE 與 (sshd) 設定哨兵', () => {
    expect(titles(inv({ sshKeys: [{ user: 'bob', fingerprint: 'UNPARSEABLE:abcd' }] }))).toEqual([
      ['high', 'bob 的授權金鑰檔出現無法解析的項目'],
    ])
    expect(titles(inv({ sshKeys: [{ user: '(sshd)', fingerprint: 'CONFIG:abcd' }] }))).toEqual([
      ['high', 'SSH 金鑰來源設定變更（AuthorizedKeysFile／AuthorizedKeysCommand／TrustedUserCAKeys）'],
    ])
  })
  it('scheduled 的 ?path:／?unit: 位置', () => {
    const s = (location: string) => inv({ scheduled: [{ location, schedule: '', executable: '', hash: 'h' }] })
    expect(titles(s('?path:abcd'))).toEqual([['medium', '新增名稱異常的排程項目（?path:abcd）']])
    expect(titles(s('?unit:abcd'))).toEqual([['medium', '新增名稱異常的排程項目（?unit:abcd）']])
    expect(titles(s('/etc/cron.d/x'))).toEqual([['medium', '新增或變更排程 /etc/cron.d/x']])
  })
})

describe('evaluateChanges', () => {
  it('hosted 回 na', () => {
    expect(evaluateChanges('hosted', inv(), inv()).check.status).toBe('na')
  })
  it('current 為 undefined 回 unknown「未取得清冊」', () => {
    expect(evaluateChanges('vm', undefined, inv()).check).toEqual({ status: 'unknown', summary: '未取得清冊' })
  })
  it('baseline 為 null 回 unknown「基準建立中」，不把全部項目當成新增', () => {
    const r = evaluateChanges('vm', inv(), null)
    expect(r.check).toEqual({ status: 'unknown', summary: '基準建立中' })
    expect(r.findings).toEqual([])
  })
  it('無變動為 ok', () => {
    expect(evaluateChanges('vm', inv(), inv()).check).toEqual({ status: 'ok', summary: '無變動' })
  })
  it('新增管理員為 bad，且不重複列為一般帳號', () => {
    const r = evaluateChanges('vm', inv({ users: ['alice', 'eve'], admins: ['alice', 'eve'] }), inv())
    expect(r.check).toEqual({ status: 'bad', summary: '新增 1 項' })
    expect(r.findings).toEqual([{ check: 'changes', severity: 'high', title: '新增管理員帳號 eve', recommendation: REC }])
  })
  it('新增一般帳號、SSH 金鑰、服務、監聽埠', () => {
    const r = evaluateChanges('vm', inv({
      users: ['alice', 'bob'],
      sshKeys: [{ user: 'alice', fingerprint: 'SHA256:x' }],
      services: ['evil.service'],
      listeners: [{ proto: 'tcp', port: 4444, process: 'nc' }],
    }), inv())
    expect(r.check).toEqual({ status: 'bad', summary: '新增 4 項' })
    expect(r.findings.map((f) => [f.severity, f.title])).toEqual(expect.arrayContaining([
      ['medium', '新增帳號 bob'],
      ['high', 'alice 新增 SSH 金鑰 SHA256:x'],
      ['medium', '新增常駐服務 evil.service'],
      ['medium', '新增監聽埠 tcp/4444（nc）'],
    ]))
    expect(r.findings.every((f) => f.recommendation === REC)).toBe(true)
  })
  it('只有 medium 項目時為 warn', () => {
    const r = evaluateChanges('vm', inv({ users: ['alice', 'bob'] }), inv())
    expect(r.check).toEqual({ status: 'warn', summary: '新增 1 項' })
  })
  it('排程內容變更（同 location 不同 hash）視為新增', () => {
    const base = inv({ scheduled: [{ location: '/etc/cron.d/x', schedule: '* * * * *', executable: '/bin/x', hash: 'h1' }] })
    const cur = inv({ scheduled: [{ location: '/etc/cron.d/x', schedule: '* * * * *', executable: '/bin/x', hash: 'h2' }] })
    const r = evaluateChanges('vm', cur, base)
    expect(r.findings.map((f) => f.title)).toEqual(['新增或變更排程 /etc/cron.d/x'])
  })
  it('移除項目不產生發現', () => {
    const r = evaluateChanges('vm', inv({ users: [], admins: [] }), inv())
    expect(r.check).toEqual({ status: 'ok', summary: '無變動' })
    expect(r.findings).toEqual([])
  })
})
