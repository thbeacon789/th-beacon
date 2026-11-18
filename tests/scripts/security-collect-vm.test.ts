import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseVmDump } from '@/core/security/collect/vm-dump'
import { runBash } from './helpers'

const SCRIPT = path.resolve(__dirname, '../../scripts/security/collect-vm.sh')
const NONCE = '0123456789abcdef0123456789abcdef'
// 固定「現在」：2026-11-18T22:30:00Z
const NOW = Date.UTC(2026, 10, 18, 22, 30, 0) / 1000

// 每個案例會啟動大量子行程（macOS 上較慢），逾時放寬
describe('security/collect-vm.sh', { timeout: 60_000 }, () => {
  let dir: string
  let bin: string
  let root: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-vm-'))
    bin = path.join(dir, 'bin')
    root = path.join(dir, 'root')
    fs.mkdirSync(bin)
    fs.mkdirSync(root)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const fake = (name: string, body: string) => {
    const p = path.join(bin, name)
    fs.writeFileSync(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  }
  const put = (rel: string, content: string) => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  const b64 = (s: string) => Buffer.from(s).toString('base64')

  const setupFakes = () => {
    fake(
      'ss',
      `cat <<'X'
udp   UNCONN 0      0            127.0.0.53%lo:53        0.0.0.0:*    users:(("systemd-resolve",pid=612,fd=13))
tcp   LISTEN 0      511                0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=1021,fd=6))
tcp   LISTEN 0      128                   [::]:22           [::]:*    users:(("sshd",pid=701,fd=4))
X`,
    )
    fake(
      'apt',
      `cat <<'X'
Listing...
openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.18 amd64 [upgradable from: 3.0.2-0ubuntu1.15]
curl/jammy-updates 7.81.0-1ubuntu1.20 amd64 [upgradable from: 7.81.0-1ubuntu1.18]
X`,
    )
    fake('apt-config', `echo 'APT::Periodic::Unattended-Upgrade "1";'`)
    fake('sshd', `printf 'port 22\\npasswordauthentication no\\npermitrootlogin prohibit-password\\n'; cat ${root}/sshd-extra 2>/dev/null`)
    fake(
      'getent',
      `case "$1" in
passwd) cat ${root}/passwd;;
group) shift; for n in "$@"; do grep "^$n:" ${root}/group; done;;
esac`,
    )
    put(
      'passwd',
      'root:x:0:0:root:/root:/bin/bash\ndeploy:x:1000:1000::/home/deploy:/bin/bash\nwww-data:x:33:33::/var/www:/usr/sbin/nologin\nbackup:x:34:34::/var/backups:/bin/false\n',
    )
    put('group', 'sudo:x:27:deploy,alice\nadmin:x:110:\nwheel:x:1001:carol,dave\n')
    fake('ssh-keygen', `l=$(cat); case "$l" in *BADKEY*) exit 1;; esac; echo "256 SHA256:fakeprint+/= deploy@laptop (ED25519)"`)
    fake('sha256sum', `exec shasum -a 256`)
    fake('date', `echo ${NOW}`)
    fake(
      'systemctl',
      `case "$1" in
list-timers) cat ${root}/timers.txt;;
list-unit-files) printf 'nginx.service enabled enabled\\nssh.service enabled enabled\\n';;
cat) shift; [ "$1" = -- ] && shift; cat "${root}/units/$1" 2>/dev/null || echo "[Timer] unit $1";;
esac`,
    )
    put('timers.txt', 'Wed 2026-11-18 23:00:00 UTC 30min left n/a n/a apt-daily.timer apt-daily.service\n')
    put('auth.txt', '2026-11-18T02:13:44+0000 host sshd[1234]: Failed password for invalid user admin from 203.0.113.9 port 51234 ssh2\n2026-11-18T02:14:00+0000 host sshd[1234]: unrelated line\n2026-11-18T03:00:12+0000 host sshd[1300]: Accepted publickey for deploy from 192.0.2.10 port 50122 ssh2\n')
    fake(
      'journalctl',
      `case "$*" in
*"-u ssh -u sshd"*) cat ${root}/auth.txt
;;
*"--utc -u app.service"*) cat <<'X'
-- Logs begin --
2026-11-18T20:01:00+0000 host app[1]: a
2026-11-18T20:59:59+0000 host app[1]: b
2026-11-18T21:00:01+0000 host app[1]: c
X
;;
*) exit 1;;
esac`,
    )
    put('etc/os-release', 'PRETTY_NAME="Ubuntu 22.04.5 LTS"\nVERSION_ID="22.04"\nID=ubuntu\n')
    put('var/run/reboot-required', '')
    put('usr/lib/update-notifier/apt-check', '#!/bin/bash\necho "5;1" >&2\n')
    fs.chmodSync(path.join(root, 'usr/lib/update-notifier/apt-check'), 0o755)
    put('etc/sudoers', '# c\nDefaults env_reset\nroot ALL=(ALL:ALL) ALL\n%sudo ALL=(ALL) ALL\nUser_Alias X = y\n')
    put('etc/sudoers.d/ops', 'ops ALL=(ALL) NOPASSWD: ALL\ndeploy ALL=(ALL) ALL\n')
    put('home/deploy/.ssh/authorized_keys', '# note\nssh-ed25519 AAAA deploy@laptop\n\n')
    put(
      'etc/crontab',
      'SHELL=/bin/sh\n# m h dom mon dow user command\n17 * * * * root cd / && run-parts --report /etc/cron.hourly\n0 3 * * * root /usr/bin/backup --password=hunter2\n@reboot root /usr/local/bin/boot.sh\n',
    )
    put('var/spool/cron/crontabs/deploy', '*/5 * * * * /home/deploy/tick.sh --token=secret\n')
  }

  const run = (env: Record<string, string> = {}) =>
    runBash(SCRIPT, [], { PATH: `${bin}:/usr/bin:/bin`, BEACON_NONCE: NONCE, BEACON_ROOT: root, ...env })

  it('BEACON_NONCE 格式不符時 exit 2', async () => {
    setupFakes()
    for (const bad of ['', 'xyz', NONCE.toUpperCase(), `${NONCE}\nfoo`]) {
      const r = await run({ BEACON_NONCE: bad })
      expect(r.code).toBe(2)
      expect(r.stdout).toBe('')
    }
  })

  it('輸出包含全部區段標記，且可被 parseVmDump 解析', async () => {
    setupFakes()
    put('var/log/nginx/access.log', '1.2.3.4 - - [18/Nov/2026:02:13:44 +0000] "GET / HTTP/1.1" 200 1\n')
    const r = await run({ BEACON_LOG_SOURCES_B64: b64('nginx\tfile\t/var/log/nginx/access.log\napp\tjournal\tapp.service\n') })
    expect(r.code).toBe(0)
    for (const n of ['listeners', 'apt_check', 'apt_upgradable', 'reboot_required', 'os_release', 'auto_updates', 'sshd', 'auth', 'users', 'admins', 'ssh_keys', 'scheduled', 'services', 'log:nginx', 'log:app']) {
      expect(r.stdout.split('\n')).toContain(`@@BEACON:${NONCE}:${n}@@`)
    }
    const f = parseVmDump(r.stdout, NONCE)
    expect(f.listeners.map((l) => `${l.proto}/${l.port}/${l.process}`)).toEqual(['udp/53/systemd-resolve', 'tcp/80/nginx', 'tcp/22/sshd'])
    expect(f.updates).toMatchObject({
      upgradable: 5,
      security: 1,
      packages: ['openssl', 'curl'],
      securityPackages: ['openssl'],
      rebootRequired: true,
      osVersion: '22.04',
      autoUpdatesEnabled: true,
    })
    expect(f.ssh).toEqual({ passwordAuthentication: false, permitRootLogin: 'prohibit-password' })
    expect(f.authLines).toHaveLength(2)
    expect(f.inventory.users).toEqual(['root', 'deploy'])
    expect(f.inventory.admins.filter((x) => !x.startsWith('?sudoers:'))).toEqual(['deploy', 'alice', 'root', '%sudo', 'ops'])
    expect(f.inventory.admins.filter((x) => x.startsWith('?sudoers:'))).toHaveLength(1) // User_Alias
    expect(f.inventory.services).toEqual(['nginx.service', 'ssh.service'])
    expect(f.inventory.sshKeys).toEqual([{ user: 'deploy', fingerprint: 'SHA256:fakeprint+/=' }])
    const sched = f.inventory.scheduled
    expect(sched.map((s) => [s.location, s.schedule, s.executable])).toEqual([
      ['/etc/crontab', '17 * * * *', 'cd'],
      ['/etc/crontab', '0 3 * * *', '/usr/bin/backup'],
      ['/etc/crontab', '@reboot', '/usr/local/bin/boot.sh'],
      ['/var/spool/cron/crontabs/deploy', '*/5 * * * *', '/home/deploy/tick.sh'],
      ['apt-daily.timer', '', ''],
    ])
    expect(sched.every((s) => /^[0-9a-f]{64}$/.test(s.hash))).toBe(true)
    expect(f.logVolume).toEqual([
      { source: 'nginx', hourly: [{ hour: '2026-11-18T02:00:00Z', count: 1 }] },
      {
        source: 'app',
        hourly: [
          { hour: '2026-11-18T20:00:00Z', count: 2 },
          { hour: '2026-11-18T21:00:00Z', count: 1 },
        ],
      },
    ])
  })

  it('指令不存在時該區段為空，其餘區段照常輸出', async () => {
    setupFakes()
    fs.rmSync(path.join(bin, 'sshd'))
    const r = await run()
    expect(r.code).toBe(0)
    const f = parseVmDump(r.stdout, NONCE)
    expect(f.ssh).toEqual({ passwordAuthentication: null, permitRootLogin: null })
    expect(f.listeners).toHaveLength(3)
    expect(f.inventory.services).toHaveLength(2)
  })

  it('scheduled 區段不含完整指令列', async () => {
    setupFakes()
    const r = await run()
    expect(r.stdout).not.toContain('hunter2')
    expect(r.stdout).not.toContain('secret')
    expect(r.stdout).not.toContain('--password')
    expect(r.stdout).not.toContain('AAAA')
  })

  it('log 檔不存在或來源不合法時：不存在輸出 ERROR，不合法略過', async () => {
    setupFakes()
    const src = ['gone\tfile\t/var/log/none.log', 'bad name\tfile\t/x', 'x\tfoo\t/y', 'y\tfile\t/a b;rm', 'z\tjournal\t$(id)', 'rel\tfile\trelative.log'].join('\n')
    const r = await run({ BEACON_LOG_SOURCES_B64: b64(src) })
    const f = parseVmDump(r.stdout, NONCE)
    expect(f.logVolume).toEqual([{ source: 'gone', error: true }])
  })

  it('file 型 log 依 UTC 整點計數，時區位移正確換算', async () => {
    setupFakes()
    const line = (ts: string) => `1.2.3.4 - - [${ts}] "GET / HTTP/1.1" 200 1\n`
    put(
      'var/log/nginx/access.log',
      line('18/Nov/2026:02:13:44 +0000') +
        line('18/Nov/2026:10:05:00 +0800') + // 02:05Z
        line('18/Nov/2026:06:59:00 +0800') + // 17 日 22:59Z，窗內
        line('18/Nov/2026:05:30:00 +0800') + // 17 日 21:30Z，窗外
        line('18/Nov/2026:00:10:00 -0500') + // 05:10Z
        'garbage line\n',
    )
    put('var/log/nginx/access.log.1', line('17/Nov/2026:23:10:00 +0000') + line('16/Nov/2026:10:00:00 +0000'))
    const r = await run({ BEACON_LOG_SOURCES_B64: b64('nginx\tfile\t/var/log/nginx/access.log') })
    const f = parseVmDump(r.stdout, NONCE)
    expect(f.logVolume).toEqual([
      {
        source: 'nginx',
        hourly: [
          { hour: '2026-11-17T22:00:00Z', count: 1 },
          { hour: '2026-11-17T23:00:00Z', count: 1 },
          { hour: '2026-11-18T02:00:00Z', count: 2 },
          { hour: '2026-11-18T05:00:00Z', count: 1 },
        ],
      },
    ])
  })

  const adminsOf = async (sudoers: string, extra: Record<string, string> = {}) => {
    setupFakes()
    put('etc/sudoers', sudoers)
    fs.rmSync(path.join(root, 'etc/sudoers.d'), { recursive: true, force: true })
    for (const [k, v] of Object.entries(extra)) put(k, v)
    const r = await run()
    return parseVmDump(r.stdout, NONCE).inventory.admins
  }
  const sentinels = (a: string[]) => a.filter((x) => x.startsWith('?sudoers:'))

  it('admins：逗號清單、uid、%群組（含成員）都會列出', async () => {
    const a = await adminsOf('evil,bob ALL=(ALL) NOPASSWD: ALL\n#1000 ALL=(ALL) ALL\n%wheel ALL=(ALL) ALL\nalice , zed ALL=(ALL) ALL\n# 普通註解\n#1 也是註解?\nDefaults:evil !requiretty\nDefaults@host x\n')
    expect(a).toEqual(expect.arrayContaining(['evil', 'bob', '#1000', '%wheel', 'carol', 'dave', 'alice', 'zed']))
    expect(a).not.toContain('Defaults')
    expect(sentinels(a)).toHaveLength(0)
  })

  it('admins：alias 與 include 輸出哨兵，alias 成員改變則雜湊改變', async () => {
    const a1 = sentinels(await adminsOf('User_Alias ADMINS = a, b\n'))
    const a2 = sentinels(await adminsOf('User_Alias ADMINS = a, b, mallory\n'))
    expect(a1).toHaveLength(1)
    expect(a2).toHaveLength(1)
    expect(a1[0]).toMatch(/^\?sudoers:[0-9a-f]{16}$/)
    expect(a1[0]).not.toBe(a2[0])
    expect(sentinels(await adminsOf('@includedir /etc/other\n#includedir /etc/x\n'))).toHaveLength(2)
    expect(sentinels(await adminsOf('!weird ALL=(ALL) ALL\n%bad;grp ALL=(ALL) ALL\n'))).toHaveLength(2)
    expect((await adminsOf('%bad;grp ALL=(ALL) ALL\n')).join('\n')).not.toContain('bad;grp')
  })

  it('admins：Defaults_evil 之類的帳號不被當成 Defaults 略過', async () => {
    const a = await adminsOf('Defaults_evil ALL=(ALL) NOPASSWD: ALL\nDefaults.x ALL=(ALL) ALL\nDefaults-y ALL=(ALL) ALL\nDefaults:bob !requiretty\nDefaults@host x\nDefaults!/bin/x y\nDefaults env_reset\n')
    expect(a).toEqual(expect.arrayContaining(['Defaults_evil', 'Defaults.x', 'Defaults-y']))
    expect(a.filter((x) => x.startsWith('Defaults'))).toHaveLength(3)
    expect(sentinels(a)).toHaveLength(0)
  })

  it('admins：primary gid 為 sudo 群組的帳號會列出', async () => {
    const a = await adminsOf('', { passwd: 'root:x:0:0:r:/root:/bin/bash\nsneaky:x:2000:27::/home/sneaky:/bin/bash\n' })
    expect(a).toContain('sneaky')
  })

  it('ssh_keys：解析失敗輸出 UNPARSEABLE、authorized_keys2 與 sshd 設定哨兵', async () => {
    setupFakes()
    put('home/deploy/.ssh/authorized_keys', 'ssh-ed25519 AAAA ok\ncommand="x" BADKEY\n')
    put('home/deploy/.ssh/authorized_keys2', 'ssh-ed25519 BBBB second\n')
    put('sshd-extra', 'authorizedkeysfile .ssh/authorized_keys\nauthorizedkeyscommand none\n')
    const r1 = await run()
    const k1 = parseVmDump(r1.stdout, NONCE).inventory.sshKeys
    expect(k1.filter((k) => k.user === 'deploy' && k.fingerprint === 'SHA256:fakeprint+/=')).toHaveLength(2)
    expect(k1.filter((k) => /^UNPARSEABLE:[0-9a-f]{16}$/.test(k.fingerprint))).toHaveLength(1)
    const c1 = k1.find((k) => k.user === '(sshd)')
    expect(c1?.fingerprint).toMatch(/^CONFIG:[0-9a-f]{16}$/)
    expect(r1.stdout).not.toContain('BADKEY')
    put('sshd-extra', 'authorizedkeysfile /elsewhere/%u\nauthorizedkeyscommand none\n')
    const k2 = parseVmDump((await run()).stdout, NONCE).inventory.sshKeys
    expect(k2.find((k) => k.user === '(sshd)')?.fingerprint).not.toBe(c1?.fingerprint)
  })

  it('users：shell 以完全相等判斷，路徑尾段像 nologin 的帳號不被隱藏', async () => {
    setupFakes()
    put(
      'passwd',
      'a:x:1:1::/h:/tmp/x/nologin\nb:x:2:2::/h:/usr/sbin/nologin\nc:x:3:3::/h:/home/evil/false\nd:x:4:4::/h:\ne:x:5:5::/h:/bin/false\n',
    )
    const f = parseVmDump((await run()).stdout, NONCE)
    expect(f.inventory.users).toEqual(['a', 'c', 'd'])
  })

  it('scheduled：反斜線 timer 被列出，啟動的 service 內容改變時 hash 改變', async () => {
    setupFakes()
    put('timers.txt', 'n/a n/a n/a n/a foo\\x2dbar.timer foo\\x2dbar.service\nn/a n/a n/a n/a bad;name.timer bad.service\n')
    const hashOf = async () => {
      const s = parseVmDump((await run()).stdout, NONCE).inventory.scheduled
      return s.find((e) => e.location === 'foo\\x2dbar.timer')?.hash
    }
    const h1 = await hashOf()
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    put('units/foo\\x2dbar.service', '[Service]\nExecStart=/tmp/evil\n')
    expect(await hashOf()).not.toBe(h1)
    const bad = parseVmDump((await run()).stdout, NONCE).inventory.scheduled.find((e) => e.location.startsWith('?unit:'))
    expect(bad?.hash).toBe(bad?.location.slice('?unit:'.length))
  })

  it('scheduled：cron.daily 等檔案被列出且內容改變時 hash 改變', async () => {
    setupFakes()
    put('etc/cron.daily/job', '#!/bin/sh\necho 1\n')
    put('etc/cron.hourly/h', 'x')
    put('etc/anacrontab', 'y')
    put('var/spool/cron/atjobs/a1', 'z')
    const get = async () => parseVmDump((await run()).stdout, NONCE).inventory.scheduled
    const s1 = await get()
    expect(s1.filter((e) => ['/etc/cron.daily/job', '/etc/cron.hourly/h', '/etc/anacrontab', '/var/spool/cron/atjobs/a1'].includes(e.location)).map((e) => e.schedule).sort()).toEqual(['anacron', 'at', 'daily', 'hourly'])
    const h1 = s1.find((e) => e.location === '/etc/cron.daily/job')?.hash
    put('etc/cron.daily/job', '#!/bin/sh\necho 2\n')
    expect((await get()).find((e) => e.location === '/etc/cron.daily/job')?.hash).not.toBe(h1)
  })

  it('scheduled：檔名含空白的 cron 檔輸出 ?path: 條目且恰為 4 欄', async () => {
    setupFakes()
    put('etc/cron.d/my job', '* * * * * root /usr/bin/x\n')
    const r = await run()
    const sec = r.stdout.split('@@BEACON:' + NONCE + ':scheduled@@\n')[1].split('@@BEACON:')[0]
    const line = sec.split('\n').find((l) => l.startsWith('?path:'))
    expect(line).toBeDefined()
    expect(line!.split('\t')).toHaveLength(4)
    expect(line!.split('\t')[2]).toBe('/usr/bin/x')
  })

  it('scheduled：NAME=value 開頭的 token 不洩漏，executable 取第一個不含 = 的 token', async () => {
    setupFakes()
    put('etc/crontab', '0 3 * * * root TOKEN=hunter2 /usr/bin/backup\n')
    const r = await run()
    expect(r.stdout).not.toContain('hunter2')
    const e = parseVmDump(r.stdout, NONCE).inventory.scheduled.find((x) => x.location === '/etc/crontab')
    expect(e?.executable).toBe('/usr/bin/backup')
  })

  it('auth：洗版 20001 行失敗登入也擠不掉較早的 Accepted，且 auth 是最後一個區段', async () => {
    setupFakes()
    const lines = ['2026-11-18T01:00:00+0000 host sshd[1]: Accepted publickey for evil from 198.51.100.7 port 1 ssh2']
    for (let i = 0; i < 20001; i++) lines.push(`2026-11-18T02:00:00+0000 host sshd[2]: Failed password for x from 203.0.113.${i % 250} port ${i} ssh2`)
    put('auth.txt', lines.join('\n') + '\n')
    const r = await run({ BEACON_LOG_SOURCES_B64: b64('app\tjournal\tapp.service\n') })
    expect(r.stdout).toContain('Accepted publickey for evil')
    const markers = r.stdout.split('\n').filter((l) => l.startsWith('@@BEACON:'))
    expect(markers[markers.length - 1]).toBe(`@@BEACON:${NONCE}:auth@@`)
    expect(markers.indexOf(`@@BEACON:${NONCE}:log:app@@`)).toBeLessThan(markers.length - 1)
    expect(parseVmDump(r.stdout, NONCE).authLines.length).toBe(20001)
  })

  it('腳本為唯讀：不含寫入、改動服務或動態執行的語法', () => {
    const code = fs
      .readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(code).not.toMatch(/\b(eval|source|tee|kill|chmod|chown|mktemp)\b/)
    expect(code).not.toMatch(/(^|[\s;|&(])(rm|mv|cp)\s/)
    expect(code).not.toMatch(/sed\s+-i/)
    expect(code).not.toMatch(/systemctl\s+(start|stop|restart|reload|enable|disable)/)
    expect(code).not.toMatch(/apt(-get)?\s+(install|upgrade|update|remove)/)
    expect(code).not.toMatch(/bash\s+-c/)
    const stripped = code.replace(/2>\/dev\/null|>\/dev\/null|2>&1|>&2/g, '')
    expect(stripped).not.toContain('>')
  })
})
