import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { normalizeImage, normalizePorts, parseVmDump, REQUIRED_SECTIONS, splitSections } from '@/core/security/collect/vm-dump'

const NONCE = '0123456789abcdef0123456789abcdef'
const fixture = readFileSync(new URL('./fixtures/vm-dump.txt', import.meta.url), 'utf8')
const mark = (name: string, nonce = NONCE) => `@@BEACON:${nonce}:${name}@@`
const build = (parts: Array<[string, string]>) => parts.map(([n, c]) => `${mark(n)}\n${c}`).join('\n') + '\n'

describe('splitSections', () => {
  it('nonce 格式不符就 throw', () => {
    expect(() => splitSections('', 'deadbeef')).toThrow()
    expect(() => splitSections('', 'G'.repeat(32))).toThrow()
  })

  it('只認 nonce 相符的區段標記', () => {
    const forgedUsers = '@@BEACON:deadbeef:users@@'
    const forgedAdmins = `@@BEACON:${'f'.repeat(32)}:admins@@`
    const dump = build([
      ['auth', `line1\n${forgedUsers}\n${forgedAdmins}\nline2`],
      ['users', 'alice'],
    ])
    const s = splitSections(dump, NONCE)
    expect(s.users).toBe('alice')
    expect(s.admins).toBeUndefined()
    expect(s.auth).toBe(`line1\n${forgedUsers}\n${forgedAdmins}\nline2`)
  })

  it('標記必須是完整一行，行內夾帶或前後多字元都算內容', () => {
    const dump = build([['auth', `x ${mark('users')}\n${mark('admins')} y`]])
    const s = splitSections(dump, NONCE)
    expect(Object.keys(s)).toEqual(['auth'])
    expect(s.auth).toContain('x @@BEACON')
  })

  it('auth log 中的使用者名稱含 TAB 與換行跳脫字元時不影響其他區段', () => {
    const evil = '2026-11-18T02:00:00+0000 host sshd[1]: Invalid user a\tb\\x0aadmins\\n from 1.2.3.4 port 22'
    const dump = build([['auth', evil], ['users', 'alice'], ['admins', 'alice']])
    const s = splitSections(dump, NONCE)
    expect(s.auth).toBe(evil)
    expect(s.users).toBe('alice')
    expect(s.admins).toBe('alice')
  })

  it('重複的區段名稱以第一個為準', () => {
    const s = splitSections(build([['users', 'a'], ['users', 'b']]), NONCE)
    expect(s.users).toBe('a')
  })
})

describe('parseVmDump', () => {
  const f = parseVmDump(fixture, NONCE)

  it('解析 ss 輸出的監聽（含 address）', () => {
    expect(f.listeners).toContainEqual({ proto: 'udp', port: 53, process: 'systemd-resolve', address: '127.0.0.53' })
    expect(f.listeners).toContainEqual({ proto: 'tcp', port: 80, process: 'nginx', address: '0.0.0.0' })
    expect(f.listeners).toContainEqual({ proto: 'tcp', port: 22, process: 'sshd', address: '::' })
    expect(f.listeners).toContainEqual({ proto: 'tcp', port: 443, process: 'nginx', address: '*' })
    expect(f.listeners).toContainEqual({ proto: 'tcp', port: 22, process: '', address: '0.0.0.0' })
    expect(f.listeners).toHaveLength(6)
  })

  it('inventory.listeners 去 address、依 proto+port 去重', () => {
    expect(f.inventory.listeners).toHaveLength(5)
    expect(f.inventory.listeners.every((l) => !('address' in l))).toBe(true)
    expect(f.inventory.listeners.filter((l) => l.port === 22)).toEqual([{ proto: 'tcp', port: 22, process: 'sshd' }])
  })

  it('更新資訊', () => {
    expect(f.updates).toEqual({
      upgradable: 5,
      security: 2,
      packages: ['openssl', 'libssl3', 'curl'],
      securityPackages: ['openssl', 'libssl3'],
      rebootRequired: true,
      osVersion: '22.04',
      autoUpdatesEnabled: true,
    })
  })

  it('apt_check 為空時以 apt_upgradable 的 -security 來源計數', () => {
    const dump = build([
      ['apt_check', ''],
      ['apt_upgradable', 'Listing...\nopenssl/jammy-updates,jammy-security 3 amd64\ncurl/jammy-updates 7 amd64\n'],
    ])
    const u = parseVmDump(dump, NONCE).updates
    expect(u.upgradable).toBe(2)
    expect(u.security).toBe(1)
    expect(u.securityPackages).toEqual(['openssl'])
  })

  it('auto_updates 0 為 false、空為 null；reboot 與 os 缺失時有預設', () => {
    expect(parseVmDump(build([['auto_updates', 'APT::Periodic::Unattended-Upgrade "0";']]), NONCE).updates.autoUpdatesEnabled).toBe(false)
    const u = parseVmDump(build([['auto_updates', '']]), NONCE).updates
    expect(u.autoUpdatesEnabled).toBeNull()
    expect(u.rebootRequired).toBe(false)
    expect(u.osVersion).toBe('')
  })

  it('sshd 鍵名大小寫不拘', () => {
    const d = build([['sshd', 'PasswordAuthentication yes\nPermitRootLogin No']])
    expect(parseVmDump(d, NONCE).ssh).toEqual({ passwordAuthentication: true, permitRootLogin: 'no' })
    expect(f.ssh).toEqual({ passwordAuthentication: false, permitRootLogin: 'prohibit-password' })
    expect(parseVmDump(build([]), NONCE).ssh).toEqual({ passwordAuthentication: null, permitRootLogin: null })
  })

  it('authLines 與 inventory 其餘欄位', () => {
    expect(f.authLines).toHaveLength(2)
    expect(f.inventory.users).toEqual(['deploy', 'alice'])
    expect(f.inventory.admins).toEqual(['deploy'])
    expect(f.inventory.sshKeys).toEqual([{ user: 'deploy', fingerprint: 'SHA256:aaa' }, { user: 'alice', fingerprint: 'SHA256:bbb' }])
    expect(f.inventory.scheduled).toEqual([{ location: '/etc/crontab', schedule: '0 * * * *', executable: '/usr/bin/backup', hash: 'deadbeef' }])
    expect(f.inventory.services).toEqual(['nginx.service', 'ssh.service'])
  })

  it('log 區段為 ERROR 時該來源標 error', () => {
    expect(f.logVolume).toEqual([
      { source: 'nginx', hourly: [{ hour: '2026-11-18T20:00:00Z', count: 120 }, { hour: '2026-11-18T21:00:00Z', count: 95 }] },
      { source: 'app', error: true },
    ])
  })

  it('格式不符的行直接略過不 throw', () => {
    const d = build([
      ['listeners', 'garbage\ntcp LISTEN 0 1 0.0.0.0:abc 0.0.0.0:*\ntcp LISTEN 0 1 0.0.0.0:99999 x\n'],
      ['ssh_keys', 'only-one-field\n'],
      ['log:x', 'bad\n2026-11-18T20:00:00Z\tNaN\n'],
    ])
    const r = parseVmDump(d, NONCE)
    expect(r.listeners).toEqual([])
    expect(r.inventory.sshKeys).toEqual([])
    // 內容非空卻沒有任何可解析的行 → 該來源為 error，而不是「沒有 log」
    expect(r.logVolume).toEqual([{ source: 'x', error: true }])
  })

  it('log 區段：內容為空維持 hourly: []；ERROR 行在資料之後也算 error；hourly 依時間排序', () => {
    const d = build([
      ['log:empty', ''],
      ['log:late', '2026-11-18T20:00:00Z\t3\nERROR\n'],
      ['log:unsorted', '2026-11-18T21:00:00Z\t1\n2026-11-18T20:00:00Z\t2\n'],
    ])
    expect(parseVmDump(d, NONCE).logVolume).toEqual([
      { source: 'empty', hourly: [] },
      { source: 'late', error: true },
      { source: 'unsorted', hourly: [{ hour: '2026-11-18T20:00:00Z', count: 2 }, { hour: '2026-11-18T21:00:00Z', count: 1 }] },
    ])
  })

  it('排程行含多個 TAB 時仍產生一筆且 hash 取最後一欄', () => {
    const r = parseVmDump(build([['scheduled', '/etc/crontab\t* * * * *\t/bin/x\ty\tz\tabc123']]), NONCE)
    expect(r.inventory.scheduled).toEqual([{ location: '/etc/crontab', schedule: '* * * * *', executable: '/bin/x y z', hash: 'abc123' }])
  })

  it('排程行不足 4 欄時仍保留一筆', () => {
    const r = parseVmDump(build([['scheduled', '/etc/crontab\tfoo\tbar\n\tonly\nsingle\n\n']]), NONCE)
    expect(r.inventory.scheduled).toEqual([
      { location: '/etc/crontab', schedule: '', executable: '', hash: 'bar' },
      { location: '(unparsed)', schedule: '', executable: '', hash: 'only' },
      { location: 'single', schedule: '', executable: '', hash: 'single' },
    ])
  })

  it('missingSections：完整 fixture 為空、空 dump 為全部、缺標記只列缺的', () => {
    expect(f.missingSections).toEqual([])
    expect(parseVmDump('', NONCE).missingSections).toEqual([...REQUIRED_SECTIONS])
    const without = fixture.split('\n').filter((l) => l !== mark('scheduled')).join('\n')
    expect(parseVmDump(without, NONCE).missingSections).toEqual(['scheduled'])
    expect(parseVmDump(build([['users', '']]), NONCE).missingSections).not.toContain('users')
  })
})

describe('normalizeImage', () => {
  it.each([
    ['repo/app:tag', 'repo/app'],
    ['host:5000/ns/app:tag', 'host:5000/ns/app'],
    ['host:5000/ns/app', 'host:5000/ns/app'],
    ['repo/app@sha256:' + 'a'.repeat(64), 'repo/app'],
    ['repo/app:tag@sha256:' + 'a'.repeat(64), 'repo/app'],
    ['nginx', 'nginx'],
    ['nginx:latest', 'nginx'],
    ['0123456789ab', '<untagged>'],
    ['a'.repeat(64), '<untagged>'],
    ['sha256:' + 'a'.repeat(64), '<untagged>'],
  ])('%s -> %s', (raw, want) => expect(normalizeImage(raw)).toBe(want))
})

describe('normalizePorts', () => {
  it('只留發佈到主機的對應，排序並去重', () => {
    expect(normalizePorts('0.0.0.0:443->443/tcp, [::]:80->80/tcp, 3000/tcp, 0.0.0.0:443->443/tcp, 0.0.0.0:80->80/tcp')).toEqual([
      '0.0.0.0:443->443/tcp', '0.0.0.0:80->80/tcp', '[::]:80->80/tcp',
    ])
  })
  it('IPv6 的 `:::80` 與 `[::]:80` 兩種寫法正規化後相同；IPv4 不受影響且不與 IPv6 合併', () => {
    expect(normalizePorts(':::80->80/tcp')).toEqual(['[::]:80->80/tcp'])
    expect(normalizePorts(':::80->80/tcp')).toEqual(normalizePorts('[::]:80->80/tcp'))
    expect(normalizePorts('0.0.0.0:80->80/tcp')).toEqual(['0.0.0.0:80->80/tcp'])
    expect(normalizePorts('127.0.0.1:3306->3306/tcp')).toEqual(['127.0.0.1:3306->3306/tcp'])
    expect(normalizePorts('0.0.0.0:80->80/tcp, :::80->80/tcp')).toEqual(['0.0.0.0:80->80/tcp', '[::]:80->80/tcp'])
  })
  it('空字串與全部未發佈 → 空陣列', () => {
    expect(normalizePorts('')).toEqual([])
    expect(normalizePorts('3000/tcp, 5432/tcp')).toEqual([])
  })
})

describe('parseVmDump containers', () => {
  const base: Array<[string, string]> = REQUIRED_SECTIONS.filter((n) => n !== 'containers').map((n) => [n, ''])
  const parse = (body: string | null) => parseVmDump(build(body === null ? base : [...base, ['containers', body]]), NONCE)

  it('fixture：正規化 image 與 ports', () => {
    expect(parseVmDump(fixture, NONCE).inventory.containers).toEqual([{ name: 'web', image: 'repo/web', ports: ['0.0.0.0:443->443/tcp', '[::]:443->443/tcp'] }])
  })
  it('NONE → 不設定該鍵；空內容 → []', () => {
    const none = parse('NONE')
    expect('containers' in none.inventory).toBe(false)
    expect(none.missingSections).toEqual([])
    expect(parse('').inventory.containers).toEqual([])
    expect(parse('').missingSections).toEqual([])
  })
  it('ERROR → 視為區段缺漏（整次掃描失敗）', () => {
    const r = parse('ERROR')
    expect(r.missingSections).toEqual(['containers'])
    expect('containers' in r.inventory).toBe(false)
  })
  it('哨兵行保留為項目；格式不符的行不可消失', () => {
    expect(parse('?container:0123456789abcdef').inventory.containers).toEqual([{ name: '?container:0123456789abcdef', image: '?', ports: [] }])
    expect(parse('only-one-column').inventory.containers).toEqual([{ name: '?container:unparsed', image: '?', ports: [] }])
  })
  it('行尾 TAB 被去掉的兩欄行（無埠容器）：ports 視為空；其他欄數仍為 unparsed', () => {
    expect(parse('db\tpostgres:16').inventory.containers).toEqual([{ name: 'db', image: 'postgres', ports: [] }])
    expect(parse('db\t').inventory.containers).toEqual([{ name: '?container:unparsed', image: '?', ports: [] }])
    expect(parse('a\tb\tc\td').inventory.containers).toEqual([{ name: '?container:unparsed', image: '?', ports: [] }])
  })
  it('缺 containers 區段列入 missingSections', () => {
    expect(parse(null).missingSections).toEqual(['containers'])
  })
})

describe('parseVmDump images', () => {
  const H = (c: string) => c.repeat(64)
  const APP = 'asia-east1-docker.pkg.dev/altinvest/backend/app'
  const base: Array<[string, string]> = REQUIRED_SECTIONS.map((n) => [n, ''])
  const parse = (body: string | null) => parseVmDump(build(body === null ? base : [...base, ['images', body]]), NONCE)

  it('四欄解析為一筆 entry', () => {
    const r = parse(`api\t${APP}:abc\tsha256:${H('1')}\t${APP}@sha256:${H('2')}`)
    expect(r.images).toEqual({
      entries: [{ container: 'api', configImage: `${APP}:abc`, imageId: `sha256:${H('1')}`, repoDigests: [`${APP}@sha256:${H('2')}`] }],
      failed: false,
    })
    expect(r.missingSections).toEqual([])
  })
  it('第 4 欄為空（行尾 TAB 被吃）→ repoDigests []；逗號切分並去空', () => {
    expect(parse(`db\tpostgres:16\tsha256:${H('1')}`).images.entries?.[0].repoDigests).toEqual([])
    expect(parse(`db\tpostgres:16\tsha256:${H('1')}\t`).images.entries?.[0].repoDigests).toEqual([])
    expect(parse(`db\tp:1\tsha256:${H('1')}\ta@sha256:${H('2')}, ,b@sha256:${H('3')}`).images.entries?.[0].repoDigests).toEqual([`a@sha256:${H('2')}`, `b@sha256:${H('3')}`])
  })
  it('NONE → entries undefined、failed false；ERROR → failed true', () => {
    expect(parse('NONE').images).toEqual({ entries: undefined, failed: false })
    expect(parse('ERROR').images).toEqual({ entries: undefined, failed: true })
    expect(parse('ERROR').missingSections).toEqual([])
  })
  it('缺 images 區段 → failed true，但 missingSections 不含 images', () => {
    const r = parse(null)
    expect(r.images).toEqual({ entries: undefined, failed: true })
    expect(r.missingSections).toEqual([])
  })
  it('欄位數不符的行略過', () => {
    const r = parse(`only-one\na\tb\na\tb\tc\td\te\n\tx\ty\tz\nok\timg:1\tsha256:${H('1')}\t`)
    expect(r.images.entries?.map((e) => e.container)).toEqual(['ok'])
  })
})
