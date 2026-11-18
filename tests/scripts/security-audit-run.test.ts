import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { auditEnv, prepareAuditDir } from '../../scripts/security/lib/audit-run.ts'

describe('auditEnv', () => {
  it('只含 PATH、HOME、CI、npm_config_ignore_scripts', () => {
    const env = auditEnv({
      BEACON_SECRET: 's', ANTHROPIC_FEDERATION_RULE_ID: 'f', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't',
      GCP_PROJECT: 'p', PATH: '/usr/bin', HOME: '/home/x',
    })
    expect(Object.keys(env).sort()).toEqual(['CI', 'HOME', 'PATH', 'npm_config_ignore_scripts'])
    expect(env.CI).toBe('true')
    expect(env.npm_config_ignore_scripts).toBe('true')
  })
  it('PATH／HOME 不存在就省略', () => {
    expect(Object.keys(auditEnv({ BEACON_SECRET: 's' })).sort()).toEqual(['CI', 'npm_config_ignore_scripts'])
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
    for (const n of ['package.json', 'pnpm-lock.yaml', '.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml']) put(n)
    const dir = prepareAuditDir(repo, 'pnpm')
    made.push(dir)
    expect(dir.startsWith(repo)).toBe(false)
    expect(fs.readdirSync(dir).sort()).toEqual(['package.json', 'pnpm-lock.yaml'])
  })
  it('npm 複製 package-lock.json', () => {
    put('package.json'); put('package-lock.json')
    const dir = prepareAuditDir(repo, 'npm')
    made.push(dir)
    expect(fs.readdirSync(dir).sort()).toEqual(['package-lock.json', 'package.json'])
  })
  it('lockfile 是 symlink → throw', () => {
    put('package.json'); put('real.yaml')
    fs.symlinkSync(path.join(repo, 'real.yaml'), path.join(repo, 'pnpm-lock.yaml'))
    expect(() => prepareAuditDir(repo, 'pnpm')).toThrow()
  })
  it('缺 package.json → throw', () => {
    put('pnpm-lock.yaml')
    expect(() => prepareAuditDir(repo, 'pnpm')).toThrow()
  })
})
