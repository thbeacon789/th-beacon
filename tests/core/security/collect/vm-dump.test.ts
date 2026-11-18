import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { parseVmDump, REQUIRED_SECTIONS, splitSections } from '@/core/security/collect/vm-dump'

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
    expect(r.logVolume).toEqual([{ source: 'x', hourly: [] }])
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
