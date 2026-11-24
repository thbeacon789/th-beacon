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
    // macOS 沒有 timeout；假的 timeout 直接執行後面的指令（略過時間參數）
    fake('timeout', `shift; exec "$@"`)
    fake(
      'systemctl',
      `case "$1" in
list-timers) cat ${root}/timers.txt;;
show) last=''; for a in "$@"; do last=$a; done; case "$last" in app.service|other.service) echo loaded;; *) echo not-found;; esac;;
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

  it('auth：帳號名 Accepted 的 Invalid user 洗版不會擠掉真實的成功登入', async () => {
    setupFakes()
    const lines = ['2026-11-18T01:00:00+0000 host sshd[1]: Accepted publickey for deploy from 192.0.2.10 port 1 ssh2']
    for (let i = 0; i < 5001; i++) lines.push(`2026-11-18T02:00:00+0000 host sshd[1]: Invalid user Accepted from 203.0.113.9 port ${i}`)
    put('auth.txt', lines.join('\n') + '\n')
    const r = await run()
    const out = r.stdout.split('\n')
    expect(out.filter((l) => l.includes('Accepted publickey for deploy'))).toHaveLength(1)
    // 洗版行只屬於失敗登入那一路，所以只出現一次（若被成功登入樣式命中會出現兩次）
    expect(out.filter((l) => l.includes('Invalid user Accepted'))).toHaveLength(5001)
  })

  it('auth：Connection closed by authenticating／invalid user 也被擷取為失敗登入', async () => {
    setupFakes()
    put('auth.txt', [
      '2026-11-18T02:00:00+0000 host sshd[9]: Connection closed by authenticating user root 203.0.113.9 port 5 [preauth]',
      '2026-11-18T02:00:01+0000 host sshd-session[9]: Connection closed by invalid user bob 203.0.113.9 port 6 [preauth]',
      '2026-11-18T02:00:02+0000 host cron[9]: Connection closed by authenticating user x 1.2.3.4 port 6 [preauth]',
    ].join('\n') + '\n')
    const r = await run()
    expect(r.stdout).toContain('authenticating user root')
    expect(r.stdout).toContain('invalid user bob')
    expect(r.stdout).not.toContain('cron[9]')
  })

  it('admins：sudoers 的 includedir 跟進一層，略過含 . 或以 ~ 結尾的檔，二層 include 只產生哨兵', async () => {
    const a = await adminsOf('', {
      'etc/sudoers.d/google-oslogin': '#includedir /var/google-sudoers.d\n',
      'var/google-sudoers.d/alice': 'alice ALL=(ALL:ALL) NOPASSWD:ALL\n',
      'var/google-sudoers.d/bob.bak': 'bob ALL=(ALL) ALL\n',
      'var/google-sudoers.d/carl~': 'carl ALL=(ALL) ALL\n',
      'var/google-sudoers.d/nested': 'erin ALL=(ALL) ALL\n#includedir /var/deeper\n',
      'var/deeper/zed': 'zed ALL=(ALL) ALL\n',
    })
    expect(a).toEqual(expect.arrayContaining(['alice', 'erin']))
    expect(a).not.toContain('bob')
    expect(a).not.toContain('carl')
    expect(a).not.toContain('zed')
    expect(sentinels(a)).toHaveLength(2) // 頂層 includedir 與二層 includedir 各一個哨兵
  })

  it('admins：#include 單檔跟進；路徑含異常字元只輸出哨兵；/etc/sudoers.d 不重複處理', async () => {
    const a = await adminsOf('#include /var/extra/file\n@include /var/e%h/x\n#includedir /etc/sudoers.d\n', {
      'var/extra/file': 'frank ALL=(ALL) ALL\n',
    })
    expect(a).toContain('frank')
    expect(sentinels(a)).toHaveLength(3)
  })

  it('admins：include 路徑的非正規寫法（//、/./、/../）只輸出哨兵', async () => {
    const a = await adminsOf('#include //proc/kmsg\n#include /./proc/kmsg\n#include /etc/../proc/kmsg\n')
    expect(sentinels(a)).toHaveLength(3)
  })

  it('admins：includedir 下的 symlink 不被解析，只輸出哨兵；一般檔照常解析', async () => {
    const a = await adminsOf('#includedir /var/inc\n', {
      'var/inc/real': 'realuser ALL=(ALL) ALL\n',
      'var/secret-target': 'leaked ALL=(ALL) ALL\n',
    })
    fs.symlinkSync(path.join(root, 'var/secret-target'), path.join(root, 'var/inc/link'))
    const r = await run()
    const b = parseVmDump(r.stdout, NONCE).inventory.admins
    expect(a).toContain('realuser')
    expect(b).toContain('realuser')
    expect(b).not.toContain('leaked')
    expect(sentinels(b)).toHaveLength(2) // includedir 行與 symlink 各一個
  })

  it('log：設定的 journal unit 不存在 → 該來源為 error', async () => {
    setupFakes()
    const r = await run({ BEACON_LOG_SOURCES_B64: b64('ghost\tjournal\tghost.service\napp\tjournal\tapp.service\n') })
    const f = parseVmDump(r.stdout, NONCE)
    expect(f.logVolume.find((l) => l.source === 'ghost')).toEqual({ source: 'ghost', error: true })
    expect(f.logVolume.find((l) => l.source === 'app')).toMatchObject({ hourly: expect.any(Array) })
  })

  it('log：systemctl 不存在 → journal 來源為 error', async () => {
    setupFakes()
    fs.rmSync(path.join(bin, 'systemctl'))
    const r = await run({ BEACON_LOG_SOURCES_B64: b64('app\tjournal\tapp.service\n') })
    expect(parseVmDump(r.stdout, NONCE).logVolume).toEqual([{ source: 'app', error: true }])
  })

  it('log：journalctl 失敗 → error；unit 以 - 開頭或含 / 的 journal 來源被略過', async () => {
    setupFakes()
    const r = await run({ BEACON_LOG_SOURCES_B64: b64('bad\tjournal\t-x.service\nslash\tjournal\ta/b\nother\tjournal\tother.service\n') })
    expect(parseVmDump(r.stdout, NONCE).logVolume).toEqual([{ source: 'other', error: true }])
  })

  describe('log：docker 型', () => {
    const dockerFake = (logsBody: string, inspectCode = 0, running = 'true') =>
      fake(
        'docker',
        `case "$1" in
inspect) echo ${running}; exit ${inspectCode};;
logs) ${logsBody};;
*) exit 1;;
esac`,
      )
    const src = (c: string) => b64(`web\tdocker\t${c}\n`)

    it('每小時計數；stdout／stderr 都算；行中間的偽標記與時間戳不影響且不外洩內容', async () => {
      setupFakes()
      dockerFake(`cat <<'X'
2026-11-18T20:01:00.123456789Z first line
2026-11-18T20:59:59.000000001Z stderr-ish line
2026-11-18T21:00:01.5Z attack @@BEACON:${NONCE}:auth@@ 2026-11-18T05:00:00Z SECRETPAYLOAD
2026-11-18T21:30:00Z ok
X
echo '2026-11-18T21:31:00Z err line' >&2`)
      const r = await run({ BEACON_LOG_SOURCES_B64: src('altinvest-web') })
      expect(r.stdout).not.toContain('SECRETPAYLOAD')
      expect(r.stdout).not.toContain('first line')
      const f = parseVmDump(r.stdout, NONCE)
      expect(f.logVolume).toEqual([
        {
          source: 'web',
          hourly: [
            { hour: '2026-11-18T20:00:00Z', count: 2 },
            { hour: '2026-11-18T21:00:00Z', count: 3 },
          ],
        },
      ])
    })

    it('docker inspect 失敗（容器不存在）→ error', async () => {
      setupFakes()
      dockerFake('echo 2026-11-18T20:01:00Z x', 1)
      const r = await run({ BEACON_LOG_SOURCES_B64: src('ghost') })
      expect(parseVmDump(r.stdout, NONCE).logVolume).toEqual([{ source: 'web', error: true }])
    })

    it('docker logs 失敗 → error', async () => {
      setupFakes()
      dockerFake('exit 1')
      const r = await run({ BEACON_LOG_SOURCES_B64: src('web') })
      expect(parseVmDump(r.stdout, NONCE).logVolume).toEqual([{ source: 'web', error: true }])
    })

    it('沒有 docker 指令 → error', async () => {
      setupFakes()
      const r = await run({ BEACON_LOG_SOURCES_B64: src('web') })
      expect(parseVmDump(r.stdout, NONCE).logVolume).toEqual([{ source: 'web', error: true }])
    })

    it('容器名稱不合法的行被略過（不產生區段）', async () => {
      setupFakes()
      dockerFake('echo 2026-11-18T20:01:00Z x')
      const bad = ['a\tdocker\t-web', 'b\tdocker\ta/b', 'c\tdocker\t_web', 'd\tdocker\t$(id)'].join('\n') + '\n'
      const r = await run({ BEACON_LOG_SOURCES_B64: b64(bad) })
      expect(parseVmDump(r.stdout, NONCE).logVolume).toEqual([])
      expect(r.stdout).not.toContain(':log:')
    })

    it('log 內含 NUL 位元組的行，其後的行仍被正確計數', async () => {
      setupFakes()
      dockerFake(`printf '2026-11-18T20:01:00Z a\\n2026-11-18T20:02:00Z b\\000c\\n2026-11-18T20:03:00Z d\\n2026-11-18T21:00:00Z e\\n'`)
      const r = await run({ BEACON_LOG_SOURCES_B64: src('web') })
      expect(parseVmDump(r.stdout, NONCE).logVolume).toEqual([
        {
          source: 'web',
          hourly: [
            { hour: '2026-11-18T20:00:00Z', count: 3 },
            { hour: '2026-11-18T21:00:00Z', count: 1 },
          ],
        },
      ])
    })

    it('對不受信任內容的 grep 一律帶 -a（log_docker／log_journal／s_auth）', () => {
      const code = fs.readFileSync(SCRIPT, 'utf8')
      const fn = (name: string) => new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(code)![0]
      for (const n of ['log_docker', 'log_journal', 's_auth']) {
        const greps = fn(n).match(/grep\s+-\S+/g) ?? []
        expect(greps.length).toBeGreaterThan(0)
        for (const g of greps) expect(g).toMatch(/-\w*a/)
      }
    })

    it('容器已停止（State.Running 非 true）→ error，而非 0 行的正常流量', async () => {
      setupFakes()
      dockerFake('true', 0, 'false')
      const r = await run({ BEACON_LOG_SOURCES_B64: src('web') })
      expect(parseVmDump(r.stdout, NONCE).logVolume).toEqual([{ source: 'web', error: true }])
    })

    it('逾時（timeout 退出碼 124）→ error', async () => {
      setupFakes()
      dockerFake('echo 2026-11-18T20:01:00Z x')
      fake('timeout', 'exit 124')
      const r = await run({ BEACON_LOG_SOURCES_B64: src('web') })
      expect(parseVmDump(r.stdout, NONCE).logVolume).toEqual([{ source: 'web', error: true }])
    })

    it('只有 docker logs 逾時（inspect 正常）→ error', async () => {
      setupFakes()
      dockerFake('echo 2026-11-18T20:01:00Z x')
      fake('timeout', 'case "$3" in logs) exit 124;; esac; shift; exec "$@"')
      const r = await run({ BEACON_LOG_SOURCES_B64: src('web') })
      expect(parseVmDump(r.stdout, NONCE).logVolume).toEqual([{ source: 'web', error: true }])
    })

    it('系統沒有 timeout 指令 → error（不退回無逾時執行）', async () => {
      setupFakes()
      dockerFake('echo 2026-11-18T20:01:00Z x')
      fs.rmSync(path.join(bin, 'timeout'))
      const r = await run({ BEACON_LOG_SOURCES_B64: src('web') })
      expect(parseVmDump(r.stdout, NONCE).logVolume).toEqual([{ source: 'web', error: true }])
    })

    it('容器存在但 24 小時內沒有 log → hourly 為空陣列而非 error', async () => {
      setupFakes()
      dockerFake('true')
      const r = await run({ BEACON_LOG_SOURCES_B64: src('web') })
      expect(parseVmDump(r.stdout, NONCE).logVolume).toEqual([{ source: 'web', hourly: [] }])
    })
  })

  it('scheduled：executable 含引號時整欄為空字串', async () => {
    setupFakes()
    put('etc/crontab', "0 3 * * * root TOKEN='a b' /bin/x\n")
    const e = parseVmDump((await run()).stdout, NONCE).inventory.scheduled.find((x) => x.location === '/etc/crontab')
    expect(e?.executable).toBe('')
  })

  it('scheduled：帶引號且含空白的環境變數值，其中段不會被當成 executable', async () => {
    setupFakes()
    put('etc/crontab', '0 3 * * * root TOKEN="a b c" /bin/x\n')
    const r = await run()
    const e = parseVmDump(r.stdout, NONCE).inventory.scheduled.find((x) => x.location === '/etc/crontab')
    expect(e?.executable).toBe('')
    const row = r.stdout.split('\n').find((l) => l.startsWith('/etc/crontab\t0 3 * * *'))
    expect(row?.split('\t')).toHaveLength(4)
    expect(r.stdout.split('\n').some((l) => l.split('\t').includes('b'))).toBe(false)
  })

  it('admins：include 指向 /proc、/sys、/dev 時不跟進，只輸出哨兵', async () => {
    const a = await adminsOf('#include /proc/kmsg\n@include /dev/zero\n#includedir /sys/kernel\n')
    expect(sentinels(a)).toHaveLength(3)
  })

  describe('containers 區段', () => {
    const section = (stdout: string) => /@@BEACON:[a-f0-9]{32}:containers@@\n([\s\S]*?)@@BEACON:/.exec(stdout)![1]
    const psFake = (body: string) => fake('docker', `case "$1" in ps) ${body};; *) exit 1;; esac`)

    it('多個容器：三欄 TAB 分隔，解析端正規化', async () => {
      setupFakes()
      psFake(`printf 'web\\trepo/web:1.2\\t0.0.0.0:443->443/tcp, [::]:443->443/tcp, 3000/tcp\\ndb\\tpostgres:16\\t5432/tcp\\n'`)
      const r = await run()
      expect(section(r.stdout)).toBe('web\trepo/web:1.2\t0.0.0.0:443->443/tcp, [::]:443->443/tcp, 3000/tcp\ndb\tpostgres:16\t5432/tcp\n')
      const f = parseVmDump(r.stdout, NONCE)
      expect(f.inventory.containers).toEqual([
        { name: 'web', image: 'repo/web', ports: ['0.0.0.0:443->443/tcp', '[::]:443->443/tcp'] },
        { name: 'db', image: 'postgres', ports: [] },
      ])
      expect(f.missingSections).toEqual([])
    })

    it('沒有 docker 指令 → NONE', async () => {
      setupFakes()
      const r = await run()
      expect(section(r.stdout)).toBe('NONE\n')
      expect('containers' in parseVmDump(r.stdout, NONCE).inventory).toBe(false)
    })

    it('docker ps 失敗 → ERROR，且解析端視為缺漏區段', async () => {
      setupFakes()
      psFake('exit 1')
      const r = await run()
      expect(section(r.stdout)).toBe('ERROR\n')
      expect(parseVmDump(r.stdout, NONCE).missingSections).toEqual(['containers'])
    })

    it('docker ps 逾時（timeout 退出碼 124）→ ERROR', async () => {
      setupFakes()
      psFake('echo web')
      fake('timeout', 'exit 124')
      const r = await run()
      expect(section(r.stdout)).toBe('ERROR\n')
    })

    it('docker 存在但系統沒有 timeout 指令 → ERROR（不退回無逾時執行）', async () => {
      setupFakes()
      psFake('echo web')
      fs.rmSync(path.join(bin, 'timeout'))
      const r = await run()
      expect(section(r.stdout)).toBe('ERROR\n')
    })

    it('沒有任何容器 → 空區段', async () => {
      setupFakes()
      psFake('true')
      const r = await run()
      expect(section(r.stdout)).toBe('')
      expect(parseVmDump(r.stdout, NONCE).inventory.containers).toEqual([])
    })

    it('名稱或欄位含非法字元 → 哨兵且不含原文', async () => {
      setupFakes()
      psFake(`printf 'ev il;rm\\trepo/x:1\\t80/tcp\\nok\\timg$(id):1\\t\\ngood\\trepo/g:1\\t\\n'`)
      const r = await run()
      const body = section(r.stdout)
      expect(body).not.toContain('ev il')
      expect(body).not.toContain('rm')
      expect(body).not.toContain('$(id)')
      const lines = body.split('\n').filter(Boolean)
      expect(lines).toHaveLength(3)
      expect(lines[0]).toMatch(/^\?container:[0-9a-f]{16}$/)
      expect(lines[1]).toMatch(/^\?container:[0-9a-f]{16}$/)
      expect(lines[2]).toBe('good\trepo/g:1\t')
    })
  })

  describe('images 區段', () => {
    const section = (stdout: string) => /@@BEACON:[a-f0-9]{32}:images@@\n([\s\S]*?)@@BEACON:/.exec(stdout)![1]
    const H = (c: string) => c.repeat(64)
    const dockerFake = (psBody: string) =>
      fake(
        'docker',
        `case "$1" in
ps) ${psBody};;
inspect) for a in "$@"; do last="$a"; done
  case "$last" in
  aaaaaaaaaaaa) printf '/api\\trepo/app:1\\tsha256:${H('1')}\\n';;
  bbbbbbbbbbbb) printf '/worker\\trepo/app:1\\tsha256:${H('1')}\\n';;
  cccccccccccc) printf '/local\\tlocal-build:1\\tsha256:${H('2')}\\n';;
  dddddddddddd) printf '/ev il\\trepo/x:1\\tsha256:${H('3')}\\n';;
  *) exit 1;;
  esac;;
image) for a in "$@"; do last="$a"; done
  case "$last" in
  sha256:${H('1')}) printf 'repo/app@sha256:${H('a')}\\n';;
  *) printf '\\n';;
  esac;;
*) exit 1;;
esac`,
      )

    it('輸出 容器名／Config.Image／imageId／RepoDigests，並可被解析', async () => {
      setupFakes()
      dockerFake(`printf 'aaaaaaaaaaaa\\nbbbbbbbbbbbb\\ncccccccccccc\\ndddddddddddd\\nnot-an-id\\neeeeeeeeeeee\\n'`)
      const r = await run()
      const body = section(r.stdout)
      // 含非法字元的容器名、非法 id、inspect 失敗的容器不輸出原文，改輸出哨兵行 ?image:<雜湊>（不可默默略過）
      const lines = body.trimEnd().split('\n')
      expect(lines.slice(0, 3)).toEqual([
        `api\trepo/app:1\tsha256:${H('1')}\trepo/app@sha256:${H('a')}`,
        `worker\trepo/app:1\tsha256:${H('1')}\trepo/app@sha256:${H('a')}`,
        `local\tlocal-build:1\tsha256:${H('2')}\t`,
      ])
      expect(lines.slice(3)).toHaveLength(3) // dddddddddddd（容器名非法）、not-an-id、eeeeeeeeeeee（inspect 失敗）
      for (const l of lines.slice(3)) expect(l).toMatch(/^\?image:[a-f0-9]{16}$/)
      expect(body).not.toContain('ev il')
      expect(body).not.toContain('not-an-id')
      const f = parseVmDump(r.stdout, NONCE)
      expect(f.images.entries).toHaveLength(6)
      expect(f.images.entries?.filter((e) => e.imageId === '')).toHaveLength(3)
      expect(f.images.failed).toBe(false)
    })

    it('沒有 docker 指令 → NONE', async () => {
      setupFakes()
      const r = await run()
      expect(section(r.stdout)).toBe('NONE\n')
    })

    it('docker ps 失敗 → ERROR，且 images 不進 missingSections', async () => {
      setupFakes()
      dockerFake('exit 1')
      const r = await run()
      expect(section(r.stdout)).toBe('ERROR\n')
      const f = parseVmDump(r.stdout, NONCE)
      expect(f.images.failed).toBe(true)
      expect(f.missingSections).toEqual(['containers'])
    })
  })

  it('腳本為唯讀：不含寫入、改動服務或動態執行的語法', () => {
    const code = fs
      .readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(code).not.toMatch(/\b(eval|source|tee|kill|chmod|chown|mktemp)\b/)
    expect(code).not.toMatch(/(^|[\s;|&(])(rm|mv|cp)\s/)
    expect(code).not.toMatch(/\b(sort|uniq)\b/)
    expect(code).not.toMatch(/sed\s+-i/)
    expect(code).not.toMatch(/systemctl\s+(start|stop|restart|reload|enable|disable)/)
    expect(code).not.toMatch(/apt(-get)?\s+(install|upgrade|update|remove)/)
    expect(code).not.toMatch(/bash\s+-c/)
    const stripped = code.replace(/2>\/dev\/null|>\/dev\/null|2>&1|>&2/g, '')
    expect(stripped).not.toContain('>')
  })
})
