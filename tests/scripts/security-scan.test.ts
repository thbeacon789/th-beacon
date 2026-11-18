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
})
