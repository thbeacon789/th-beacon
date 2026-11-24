import { createHmac } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSecurityScanPayload } from '@/core/security/payload'
import { startServer, type FakeServer, type Handler } from './helpers'

const ROOT = path.resolve(__dirname, '../..')
const SCAN = path.join(ROOT, 'scripts/security/scan.mts')
const FIX = path.join(__dirname, 'fixtures/security')
const SECRET = 'test-secret-value-9f3a'

const VM_TARGET = {
  service: 'vmsvc', secretEnv: 'X', kind: 'vm', domains: ['app.example.test'],
  expectedPublicPorts: [80, 443], changesIgnore: { users: ['alice'] },
}
const HOSTED_TARGET = { service: 'hostedsvc', secretEnv: 'X', kind: 'hosted', domains: ['www.example.test'] }

interface Run { code: number | null; stdout: string; stderr: string }

describe('scripts/security/scan.mts', () => {
  let dir: string
  let server: FakeServer | undefined

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secscan-'))
    fs.writeFileSync(path.join(dir, 'targets.json'), JSON.stringify([VM_TARGET, HOSTED_TARGET]))
  })
  afterEach(async () => {
    await server?.close()
    server = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const start = async (h: Handler) => (server = await startServer(h))
  const okHandler: Handler = () => ({ status: 201, json: { id: 'x' } })

  function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
    return new Promise((resolve) => {
      execFile(
        'node', [SCAN, ...args],
        {
          cwd: ROOT,
          env: {
            PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
            SECURITY_TARGETS_FILE: path.join(dir, 'targets.json'),
            BEACON_URL: server?.url ?? 'http://127.0.0.1:9', BEACON_SECRET: SECRET,
            ...env,
          },
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
          resolve({ code, stdout, stderr })
        },
      )
    })
  }

  /** 複製 fixture 到暫存目錄以便刪改檔案 */
  function fixture(name: 'vm' | 'hosted', mutate?: (d: string) => void): string {
    const d = path.join(dir, `fx-${name}`)
    fs.cpSync(path.join(FIX, name), d, { recursive: true })
    mutate?.(d)
    return d
  }

  const scans = () => server!.requests.filter((r) => r.path === '/api/security-scan')
  const usages = () => server!.requests.filter((r) => r.path === '/api/ai-usage')

  it('未知的 target exit 2', async () => {
    await start(okHandler)
    const r = await run(['--target', 'nope', '--dry-run', fixture('vm')])
    expect(r.code).toBe(2)
    expect(server!.requests).toHaveLength(0)
  })

  it('vm 乾跑：payload 可通過驗證，簽章正確，exit 0', async () => {
    await start(okHandler)
    const r = await run(['--target', 'vmsvc', '--dry-run', fixture('vm')])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    expect(scans()).toHaveLength(1)
    const req = scans()[0]
    expect(req.headers['x-beacon-service']).toBe('vmsvc')
    const ts = req.headers['x-beacon-timestamp'] as string
    const expected = createHmac('sha256', SECRET).update(`${ts}.${req.body}`).digest('hex')
    expect(req.headers['x-beacon-signature']).toBe(`sha256=${expected}`)

    const body = JSON.parse(req.body)
    const parsed = parseSecurityScanPayload(body, new Date())
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
    expect(body.kind).toBe('vm')
    expect(body.inventory.users).not.toContain('alice')
    expect(body.inventory.users).toContain('deploy')
    expect(body.inventory.sshKeys.map((k: { user: string }) => k.user)).not.toContain('alice')
    expect(body.checks.updates.status).toBe('warn')
  })

  const BACKEND_HEX = 'b1'.repeat(32)

  it('vm 乾跑：deps 依映像檔 fixture 判燈（caddy critical → bad），backend 帶 api 與 worker', async () => {
    await start(okHandler)
    const r = await run(['--target', 'vmsvc', '--dry-run', fixture('vm')])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    const body = JSON.parse(scans()[0].body)
    expect(body.checks.deps.status).toBe('bad')
    expect(body.deps).toHaveLength(2)
    const backend = body.deps.find((d: { digest: string }) => d.digest === `sha256:${BACKEND_HEX}`)
    expect(backend.containers).toEqual(['api', 'worker'])
    expect(parseSecurityScanPayload(body, new Date()).ok).toBe(true)
  })

  it('images 區段 ERROR：deps 為 unknown，其他檢查照常推送，exit 1', async () => {
    await start(okHandler)
    const d = fixture('vm', (x) => {
      const p = path.join(x, 'vm-dump.txt')
      const text = fs.readFileSync(p, 'utf8')
      const re = /(@@BEACON:0{32}:images@@\n)[\s\S]*?(?=@@BEACON:0{32}:log:nginx@@)/
      expect(re.test(text)).toBe(true)
      fs.writeFileSync(p, text.replace(re, '$1ERROR\n'))
    })
    const r = await run(['--target', 'vmsvc', '--dry-run', d])
    expect(r.code).toBe(1)
    expect(scans()).toHaveLength(1)
    const body = JSON.parse(scans()[0].body)
    expect(body.checks.deps.status).toBe('unknown')
    expect(body.checks.updates.status).toBe('warn')
    expect(body.deps).toEqual([])
  })

  it('某映像檔 fixture 缺失：該映像檔帶 error，快照仍推送，exit 1', async () => {
    await start(okHandler)
    const d = fixture('vm', (x) => fs.rmSync(path.join(x, 'osv', `${BACKEND_HEX}.json`)))
    const r = await run(['--target', 'vmsvc', '--dry-run', d])
    expect(r.code).toBe(1)
    expect(scans()).toHaveLength(1)
    const body = JSON.parse(scans()[0].body)
    const backend = body.deps.find((x: { digest: string }) => x.digest === `sha256:${BACKEND_HEX}`)
    expect(backend.error).toBe('fixture 不存在')
    expect(body.checks.deps.status).toBe('bad')
  })

  it('deps 欄位驗證失敗：歸咎 deps 而非判讀（判讀三項不被洗成 unknown）', async () => {
    await start(okHandler)
    // 51 個映像檔超過 payload 上限 50；改成 deps 的 error 後仍超過，所以不會推送，
    // 重點是錯誤訊息指向 deps、不拿判讀開刀
    const d = fixture('vm', (x) => {
      const p = path.join(x, 'vm-dump.txt')
      const text = fs.readFileSync(p, 'utf8')
      const extra = Array.from({ length: 51 }, (_, i) => `c${i}\timg${i}:1\tsha256:${String(i).padStart(2, '0').repeat(32)}\timg${i}@sha256:${String(i).padStart(2, '0').repeat(32)}`).join('\n')
      fs.writeFileSync(p, text.replace(/(@@BEACON:0{32}:images@@\n)/, `$1${extra}\n`))
    })
    const r = await run(['--target', 'vmsvc', '--dry-run', d])
    expect(r.stderr).toContain('deps 輸出未通過驗證')
    expect(r.stderr).not.toContain('判讀輸出未通過驗證')
    expect(r.code).toBe(1)
  })

  it('hosted 乾跑：payload 不含 deps', async () => {
    await start(okHandler)
    await run(['--target', 'hostedsvc', '--dry-run', fixture('hosted')])
    const body = JSON.parse(scans()[0].body)
    expect(body).not.toHaveProperty('deps')
    expect(body.checks).not.toHaveProperty('deps')
  })

  it('判讀輸出有空白 title：仍推送快照（憑證與暴露面保留），三項為 unknown，exit 1', async () => {
    await start(okHandler)
    const d = fixture('vm', (x) => {
      const p = path.join(x, 'judgment.json')
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      j.findings[0].title = '   '
      fs.writeFileSync(p, JSON.stringify(j))
    })
    const r = await run(['--target', 'vmsvc', '--dry-run', d])
    expect(r.code, r.stdout + r.stderr).toBe(1)
    expect(scans()).toHaveLength(1)
    const body = JSON.parse(scans()[0].body)
    for (const k of ['ports', 'updates', 'logins']) expect(body.checks[k].status).toBe('unknown')
    // 判讀 findings 被清空；deps 的 findings 由排程端確定性產生，不受影響
    expect(body.findings.filter((f: { check: string }) => f.check !== 'deps')).toEqual([])
    expect(body.certs.length).toBeGreaterThan(0)
    expect(body.exposure.length).toBeGreaterThan(0)
    expect(parseSecurityScanPayload(body, new Date()).ok).toBe(true)
  })

  it('輸出不含 BEACON_SECRET', async () => {
    await start(okHandler)
    const r = await run(['--target', 'vmsvc', '--dry-run', fixture('vm')])
    expect(r.stdout + r.stderr).not.toContain(SECRET)
  })

  it('vm 乾跑且判讀成功時另送 source 為 ci_security 的 ai-usage', async () => {
    await start(okHandler)
    const r = await run(['--target', 'vmsvc', '--dry-run', fixture('vm')])
    expect(r.code).toBe(0)
    expect(usages()).toHaveLength(1)
    expect(JSON.parse(usages()[0].body)).toEqual({
      source: 'ci_security', model: 'claude-sonnet-5-5', inputTokens: 1200, outputTokens: 300,
    })
    expect(usages()[0].headers['x-beacon-service']).toBe('vmsvc')
  })

  it('判讀失敗（無 judgment.json）：仍推快照，三項為 unknown，exit 1，不送 ai-usage', async () => {
    await start(okHandler)
    const d = fixture('vm', (x) => fs.rmSync(path.join(x, 'judgment.json')))
    const r = await run(['--target', 'vmsvc', '--dry-run', d])
    expect(r.code).toBe(1)
    expect(scans()).toHaveLength(1)
    const body = JSON.parse(scans()[0].body)
    for (const k of ['ports', 'updates', 'logins']) expect(body.checks[k].status).toBe('unknown')
    expect(usages()).toHaveLength(0)
  })

  it('hosted 乾跑：不含 logVolume 與 inventory，ports 與 logins 為 na', async () => {
    await start(okHandler)
    const r = await run(['--target', 'hostedsvc', '--dry-run', fixture('hosted')])
    expect(r.code, r.stdout + r.stderr).toBe(0)
    const body = JSON.parse(scans()[0].body)
    expect(body.kind).toBe('hosted')
    expect(body).not.toHaveProperty('logVolume')
    expect(body).not.toHaveProperty('inventory')
    expect(body.checks.ports.status).toBe('na')
    expect(body.checks.logins.status).toBe('na')
    expect(parseSecurityScanPayload(body, new Date()).ok).toBe(true)
  })

  it('beacon 回 401 時 exit 1', async () => {
    await start(() => ({ status: 401, json: { error: 'unauthorized' } }))
    const r = await run(['--target', 'vmsvc', '--dry-run', fixture('vm')])
    expect(r.code).toBe(1)
    expect(usages()).toHaveLength(0)
  })

  it('vm-dump 缺必要區段視為收集失敗：exit 1 且不推快照', async () => {
    await start(okHandler)
    const d = fixture('vm', (x) => {
      const p = path.join(x, 'vm-dump.txt')
      const text = fs.readFileSync(p, 'utf8')
      // 移除 sshd 區段標記，使該區段缺漏
      fs.writeFileSync(p, text.replace('@@BEACON:00000000000000000000000000000000:sshd@@\n', ''))
    })
    const r = await run(['--target', 'vmsvc', '--dry-run', d])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('sshd')
    expect(scans()).toHaveLength(0)
  })

  it('外部檢查不完整（有 exposure 無 cert）：仍推送快照但 exit 1', async () => {
    await start(okHandler)
    const d = fixture('vm', (x) => {
      const p = path.join(x, 'external.json')
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      j.certs = []
      fs.writeFileSync(p, JSON.stringify(j))
    })
    const r = await run(['--target', 'vmsvc', '--dry-run', d])
    expect(r.code).toBe(1)
    expect(scans()).toHaveLength(1)
    expect(r.stderr).toContain('app.example.test')
  })

  it('hosted 的 audit 失敗（無 audit.json）：推快照、updates 為「相依套件稽核失敗」、exit 1', async () => {
    await start(okHandler)
    const d = fixture('hosted', (x) => fs.rmSync(path.join(x, 'audit.json')))
    const r = await run(['--target', 'hostedsvc', '--dry-run', d])
    expect(r.code).toBe(1)
    const body = JSON.parse(scans()[0].body)
    expect(body.checks.updates).toEqual({ status: 'unknown', summary: '相依套件稽核失敗' })
  })

  it('缺 BEACON_SECRET 時 exit 2 且不推送', async () => {
    await start(okHandler)
    const r = await run(['--target', 'vmsvc', '--dry-run', fixture('vm')], { BEACON_SECRET: '' })
    expect(r.code).toBe(2)
    expect(server!.requests).toHaveLength(0)
  })
})
