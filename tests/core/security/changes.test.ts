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
  it('最舊快照沒有容器清單時，以最舊且含容器清單的快照補上 containers，其餘欄位仍取最舊者', () => {
    const oldest = inv({ users: ['old'] })
    const mid = inv({ users: ['mid'], containers: [{ name: 'api', image: 'repo/app', ports: [] }] })
    const newest = inv({ users: ['new'], containers: [{ name: 'api', image: 'repo/app', ports: [] }, { name: 'x', image: 'y', ports: [] }] })
    const r = pickBaseline([
      { scannedAt: '2026-11-17T00:00:00.000Z', inventory: newest },
      { scannedAt: '2026-11-10T00:00:00.000Z', inventory: oldest },
      { scannedAt: '2026-11-12T00:00:00.000Z', inventory: mid },
    ])
    expect(r).toEqual({ ...oldest, containers: mid.containers })
    expect(oldest.containers).toBeUndefined() // 不可改動輸入
  })
  it('窗內沒有任何快照含容器清單時，基準不帶 containers', () => {
    const a = inv({ users: ['a'] })
    expect(pickBaseline([{ scannedAt: '2026-11-12T00:00:00.000Z', inventory: a }])).toBe(a)
  })
  it('最舊快照本身含容器清單（即使為空陣列）時原樣回傳', () => {
    const a = inv({ containers: [] })
    const b = inv({ containers: [{ name: 'api', image: 'repo/app', ports: [] }] })
    expect(
      pickBaseline([
        { scannedAt: '2026-11-12T00:00:00.000Z', inventory: a },
        { scannedAt: '2026-11-13T00:00:00.000Z', inventory: b },
      ]),
    ).toBe(a)
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
  it('帳號已在基準的管理員清單中，晚一步才出現在帳號清單時不視為新增', () => {
    // OS Login 帳號在 sudoers 立即可見，getent passwd 要等本機快取刷新才列出
    const base = inv({ users: ['alice'], admins: ['alice', 'navibluer_gmail_com', '%google-sudoers'] })
    const cur = inv({ users: ['alice', 'navibluer_gmail_com'], admins: ['alice', 'navibluer_gmail_com', '%google-sudoers'] })
    const r = evaluateChanges('vm', cur, base)
    expect(r.check).toEqual({ status: 'ok', summary: '無變動' })
    expect(r.findings).toEqual([])
  })
  it('基準管理員清單中的哨兵條目不會遮蔽同字面的帳號名', () => {
    const base = inv({ admins: ['alice', '%ops'] })
    const r = evaluateChanges('vm', inv({ users: ['alice', 'ops'], admins: ['alice', '%ops'] }), base)
    expect(r.findings.map((f) => f.title)).toEqual(['新增帳號 ops'])
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

describe('evaluateChanges 容器', () => {
  const c = (name: string, image = 'repo/app', ports: string[] = []) => ({ name, image, ports })
  const titles = (cur?: Inventory['containers'], base?: Inventory['containers']) =>
    evaluateChanges('vm', inv({ containers: cur }), inv({ containers: base })).findings.map((f) => [f.severity, f.title])

  it('新增容器', () => {
    expect(titles([c('a'), c('b', 'evil/x')], [c('a')])).toEqual([['medium', '新增容器 b（映像檔 evil/x）']])
  })
  it('映像檔來源變更', () => {
    expect(titles([c('a', 'evil/app')], [c('a')])).toEqual([['medium', '容器 a 的映像檔來源由 repo/app 變為 evil/app']])
  })
  it('新增對外埠對應', () => {
    expect(titles([c('a', 'repo/app', ['0.0.0.0:22->22/tcp'])], [c('a')])).toEqual([['medium', '容器 a 新增對外埠對應 0.0.0.0:22->22/tcp']])
  })
  it('容器消失、port 減少、無變化都不報', () => {
    expect(titles([c('a')], [c('a'), c('b')])).toEqual([])
    expect(titles([c('a', 'repo/app', [])], [c('a', 'repo/app', ['0.0.0.0:80->80/tcp'])])).toEqual([])
    expect(titles([c('a')], [c('a')])).toEqual([])
  })
  it('基準或目前沒有 containers：跳過，狀態維持 ok', () => {
    expect(titles([c('a')], undefined)).toEqual([])
    expect(evaluateChanges('vm', inv({ containers: [c('a')] }), inv()).check.status).toBe('ok')
  })
  it('基準有容器但目前清單無法取得 → 一筆 high 且狀態為 bad', () => {
    const r = evaluateChanges('vm', inv({ containers: undefined }), inv({ containers: [c('a'), c('b')] }))
    expect(r.findings.map((f) => [f.severity, f.title])).toEqual([
      ['high', '容器清單無法取得（先前有 2 個容器）；docker 可能已被移除或搬離預設路徑'],
    ])
    expect(r.check.status).toBe('bad')
  })
  it('基準為空陣列或未定義、目前 undefined → 不報', () => {
    expect(titles(undefined, [])).toEqual([])
    expect(titles(undefined, undefined)).toEqual([])
    expect(evaluateChanges('vm', inv({ containers: undefined }), inv({ containers: [] })).check.status).toBe('ok')
  })
  it('標題超長時截斷到 MAX_TITLE 且通過 payload 驗證', () => {
    const f = evaluateChanges('vm', inv({ containers: [c('n', 'x'.repeat(300))] }), inv({ containers: [] })).findings[0]
    expect(f.title.length).toBeLessThanOrEqual(120)
    expect(f.title.startsWith('新增容器 n（映像檔 xxx')).toBe(true)
  })
})
