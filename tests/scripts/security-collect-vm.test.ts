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
    fake('sshd', `printf 'port 22\\npasswordauthentication no\\npermitrootlogin prohibit-password\\n'`)
    fake(
      'getent',
      `case "$1" in
passwd) printf 'root:x:0:0:root:/root:/bin/bash\\ndeploy:x:1000:1000::/home/deploy:/bin/bash\\nwww-data:x:33:33::/var/www:/usr/sbin/nologin\\nbackup:x:34:34::/var/backups:/bin/false\\n';;
group) printf 'sudo:x:27:deploy,alice\\nadmin:x:110:\\n';;
esac`,
    )
    fake('ssh-keygen', `cat >/dev/null; echo "256 SHA256:fakeprint+/= deploy@laptop (ED25519)"`)
    fake('sha256sum', `exec shasum -a 256`)
    fake('date', `echo ${NOW}`)
    fake(
      'systemctl',
      `case "$1" in
list-timers) printf 'Wed 2026-11-18 23:00:00 UTC 30min left n/a n/a apt-daily.timer apt-daily.service\\n';;
list-unit-files) printf 'nginx.service enabled enabled\\nssh.service enabled enabled\\n';;
cat) echo "[Timer] unit $2";;
esac`,
    )
    fake(
      'journalctl',
      `case "$*" in
*"-u ssh -u sshd"*) cat <<'X'
2026-11-18T02:13:44+0000 host sshd[1234]: Failed password for invalid user admin from 203.0.113.9 port 51234 ssh2
2026-11-18T02:14:00+0000 host sshd[1234]: unrelated line
2026-11-18T03:00:12+0000 host sshd[1300]: Accepted publickey for deploy from 192.0.2.10 port 50122 ssh2
X
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
    expect(f.inventory.admins).toEqual(['deploy', 'alice', 'root', 'ops'])
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
