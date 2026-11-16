import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runBash, startServer, type FakeServer } from './helpers'

const SCRIPT = path.resolve(__dirname, '../../scripts/ai-fix-e2e-failure.sh')
const DAY = 86_400_000

const RESULT = {
  fixed: true,
  target: 'test',
  rootCause: '登入頁 selector 已改名',
  changeSummary: '更新 selector',
  prTitle: '更新登入頁 selector',
  verificationNotes: '本機未驗證',
}
const successOut = (so: unknown = RESULT, extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.42,
  result: JSON.stringify(so),
  structured_output: so,
  ...extra,
})

interface Plan {
  writes?: Record<string, string>
  renames?: [string, string][]
  deletes?: string[]
  stdout?: unknown
  exitCode?: number
}

// 假 claude：劇本路徑與記錄目錄寫死在檔內（agent env 已被隔離，不能靠 env 傳）
const fakeClaudeSource = (planPath: string, recDir: string) => `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planPath)}, 'utf8'))
const rec = ${JSON.stringify(recDir)}
let stdin = ''
process.stdin.on('data', (c) => (stdin += c))
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(rec, 'calls.log'), 'x\\n')
  fs.writeFileSync(path.join(rec, 'argv.json'), JSON.stringify(process.argv.slice(2)))
  fs.writeFileSync(path.join(rec, 'stdin.txt'), stdin)
  const tf = process.env.ANTHROPIC_IDENTITY_TOKEN_FILE
  let token = null
  if (tf) { try { token = { content: fs.readFileSync(tf, 'utf8'), mode: (fs.statSync(tf).mode & 0o777).toString(8) } } catch {} }
  let tokenDir = null, workDir = null
  if (tf) { try { tokenDir = fs.readdirSync(path.dirname(tf)); workDir = fs.readdirSync(path.dirname(path.dirname(tf))) } catch {} }
  fs.writeFileSync(path.join(rec, 'env.json'), JSON.stringify({ env: process.env, token, tokenDir, workDir }))
  for (const [p, c] of Object.entries(plan.writes || {})) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c) }
  for (const [a, b] of plan.renames || []) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b) }
  for (const p of plan.deletes || []) fs.rmSync(p)
  const out = plan.stdout
  process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out))
  process.exit(plan.exitCode || 0)
})
`
const fakeGhSource = (recDir: string) => `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const rec = ${JSON.stringify(recDir)}
const a = process.argv.slice(2)
fs.appendFileSync(path.join(rec, 'gh.log'), JSON.stringify(a) + '\\n')
const has = (f) => fs.existsSync(path.join(rec, f))
if (a[0] === 'pr' && a[1] === 'list' && a.includes('url,headRefOid,baseRefName,isCrossRepository')) {
  let t = has('gh-open-prs.json') ? fs.readFileSync(path.join(rec, 'gh-open-prs.json'), 'utf8') : '[]'
  if (t.includes('@HEAD')) t = t.split('@HEAD').join(require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
  process.stdout.write(t)
} else if (a[0] === 'pr' && a[1] === 'comment') {
  if (has('gh-fail-comment')) process.exit(1)
} else if (a[0] === 'pr' && a[1] === 'list') process.stdout.write(fs.readFileSync(path.join(rec, 'gh-list.json'), 'utf8'))
else if (a[0] === 'pr' && a[1] === 'create') {
  const n = fs.readdirSync(rec).filter((f) => f.startsWith('body-')).length
  fs.writeFileSync(path.join(rec, 'body-' + n + '.md'), fs.readFileSync(a[a.indexOf('--body-file') + 1]))
  if (has('gh-fail-all') || (a.includes('--reviewer') && has('gh-fail-reviewer'))) { process.stderr.write('boom\\n'); process.exit(1) }
  process.stdout.write('https://github.com/o/r/pull/9\\n')
}
`

describe('ai-fix-e2e-failure.sh', () => {
  let dir: string
  let repo: string
  let origin: string
  let rec: string
  let bin: string
  let server: FakeServer | undefined
  let apiStatus = 201

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  const put = (rel: string, content: string) => {
    const p = path.join(repo, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  const setPlan = (p: Plan) => fs.writeFileSync(path.join(rec, 'plan.json'), JSON.stringify(p))
  const setPrList = (list: unknown[]) => fs.writeFileSync(path.join(rec, 'gh-list.json'), JSON.stringify(list))
  const calls = () => (fs.existsSync(path.join(rec, 'calls.log')) ? fs.readFileSync(path.join(rec, 'calls.log'), 'utf8').split('\n').filter(Boolean).length : 0)
  const argv = () => JSON.parse(fs.readFileSync(path.join(rec, 'argv.json'), 'utf8')) as string[]
  const agentEnv = () =>
    JSON.parse(fs.readFileSync(path.join(rec, 'env.json'), 'utf8')) as {
      env: Record<string, string>
      token: { content: string; mode: string } | null
      tokenDir: string[] | null
      workDir: string[] | null
    }
  const stdin = () => fs.readFileSync(path.join(rec, 'stdin.txt'), 'utf8')
  const ghLog = () =>
    fs.existsSync(path.join(rec, 'gh.log'))
      ? fs.readFileSync(path.join(rec, 'gh.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
      : []
  const porcelain = () => sh(repo, 'status', '--porcelain')
  const flag = (name: string) => {
    const a = argv()
    const i = a.indexOf(name)
    return i >= 0 ? a[i + 1] : undefined
  }

  const beacon = () => ({ BEACON_BASE_URL: server!.url, BEACON_SERVICE: 'svc-a' })
  const apiReqs = () => server!.requests.filter((q) => q.path.startsWith('/api/'))
  const bodies = () =>
    fs
      .readdirSync(rec)
      .filter((f) => f.startsWith('body-'))
      .sort()
      .map((f) => fs.readFileSync(path.join(rec, f), 'utf8'))
  const branchRef = 'refs/heads/ai-fix/android-e2e-prod'
  // 同一個 it 內重跑前重置：回 main、刪遠端分支、清請求記錄
  const fresh = () => {
    sh(repo, 'switch', '-q', 'main')
    sh(origin, 'update-ref', '-d', branchRef)
    server!.requests.length = 0
  }
  const setOpenPrs = (v: Partial<{ url: string; headRefOid: string; baseRefName: string; isCrossRepository: boolean }>[]) =>
    fs.writeFileSync(path.join(rec, 'gh-open-prs.json'), JSON.stringify(v))
  const goodPr = { url: 'https://github.com/o/r/pull/77', headRefOid: '@HEAD', baseRefName: 'main', isCrossRepository: false }

  const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    BASE_BRANCH: 'main',
    RUN_URL: 'https://github.com/o/r/actions/runs/1',
    AI_FIX_REVIEWER: 'octocat',
    GH_TOKEN: 'ghs_SECRET',
    BEACON_SECRET: 'beacon-secret',
    TRUSTNEL_E2E_PASSWORD: 'pw-secret',
    ANTHROPIC_FEDERATION_RULE_ID: 'fr_1',
    ANTHROPIC_ORGANIZATION_ID: 'org_1',
    ANTHROPIC_SERVICE_ACCOUNT_ID: 'sa_1',
    ANTHROPIC_WORKSPACE_ID: 'ws_1',
    ACTIONS_ID_TOKEN_REQUEST_URL: `${server!.url}/oidc?x=1`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'REQ_TOKEN',
    ...extra,
  })
  const run = (extra: Record<string, string> = {}, args?: string[]) =>
    runBash(
      SCRIPT,
      args ?? ['android', 'android-e2e-prod', path.join(dir, 'known.md'), path.join(dir, 'diag.json'), path.join(dir, 'log.txt')],
      baseEnv(extra),
      repo,
    )

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aifix-'))
    repo = path.join(dir, 'repo')
    origin = path.join(dir, 'origin.git')
    rec = path.join(dir, 'rec')
    bin = path.join(dir, 'bin')
    for (const d of [repo, rec, bin]) fs.mkdirSync(d)
    sh(dir, 'init', '--bare', '-b', 'main', origin)
    sh(repo, 'init', '-b', 'main')
    sh(repo, 'config', 'user.email', 't@example.com')
    sh(repo, 'config', 'user.name', 'tester')
    put('CLAUDE.md', '# 專案規範 MARKER-CLAUDE-MD\n')
    put('app/Login.kt', 'class Login\n')
    put('scripts/e2e.sh', 'echo e2e\n')
    put('.github/workflows/ci.yml', 'name: ci\n')
    put('phone/src/androidTest/LoginTest.kt', 'class LoginTest\n')
    sh(repo, 'add', '--all')
    sh(repo, 'commit', '-m', 'init')
    sh(repo, 'remote', 'add', 'origin', origin)
    sh(repo, 'push', 'origin', 'main')

    fs.writeFileSync(path.join(dir, 'known.md'), '已知問題 MARKER-KNOWN\n')
    fs.writeFileSync(path.join(dir, 'diag.json'), JSON.stringify({ category: 'app', severity: 'P1', reason: 'MARKER-REASON', suggestion: 'MARKER-SUGGESTION', needsCodeChange: true }))
    fs.writeFileSync(path.join(dir, 'log.txt'), 'E2E LOG MARKER-LOG\n')
    fs.writeFileSync(path.join(bin, 'claude'), fakeClaudeSource(path.join(rec, 'plan.json'), rec), { mode: 0o755 })
    fs.writeFileSync(path.join(bin, 'gh'), fakeGhSource(rec), { mode: 0o755 })
    setPrList([])
    setPlan({ writes: { 'app/Login.kt': 'class Login2\n' }, stdout: successOut() })
    apiStatus = 201
    server = await startServer((req) =>
      req.path.startsWith('/oidc') ? { json: { value: 'JWT_FAKE' } } : req.path.startsWith('/api/') ? { status: apiStatus, json: {} } : { json: {} },
    )
  })
  afterEach(async () => {
    await server?.close()
    server = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('參數與前置檢查', () => {
    it.each(['has space', 'a/b'])('heartbeat-name 不合法（%s）→ exit 2', async (name) => {
      const r = await run({}, ['android', name, 'k', 'd', 'l'])
      expect(r.code).toBe(2)
      expect(calls()).toBe(0)
    })

    it('缺必要 env → exit 2', async () => {
      const r = await run({ AI_FIX_REVIEWER: '' })
      expect(r.code).toBe(2)
      expect(calls()).toBe(0)
    })

    it('呼叫前工作樹不乾淨 → 不呼叫 claude，STATUS=failed，且不動使用者的檔案', async () => {
      put('untracked.txt', 'x')
      const r = await run()
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('STATUS=failed')
      expect(calls()).toBe(0)
      expect(fs.existsSync(path.join(repo, 'untracked.txt'))).toBe(true)
    })
  })

  describe('去重', () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString().replace(/\.\d+Z$/, 'Z')

    it('open PR 已存在 → 不呼叫 claude、無請求、exit 0', async () => {
      setPrList([{ number: 1, state: 'OPEN', mergedAt: null, closedAt: null }])
      const r = await run()
      expect(r.code).toBe(0)
      expect(calls()).toBe(0)
      expect(server!.requests).toHaveLength(0)
      expect(ghLog()[0]).toEqual(expect.arrayContaining(['pr', 'list', '--head', 'ai-fix/android-e2e-prod', '--state', 'all']))
    })

    it.each([
      ['3 天前未合併即關閉（預設冷卻 7 天）→ 跳過', 3, null, {}, false],
      ['8 天前關閉 → 繼續', 8, null, {}, true],
      ['3 天前已合併 → 繼續', 3, 'merged', {}, true],
      ['AI_FIX_COOLDOWN_DAYS=1 時 3 天前關閉 → 繼續', 3, null, { AI_FIX_COOLDOWN_DAYS: '1' }, true],
    ])('%s', async (_n, days, merged, env, proceeds) => {
      setPrList([{ number: 2, state: merged ? 'MERGED' : 'CLOSED', mergedAt: merged ? iso(days) : null, closedAt: iso(days) }])
      const r = await run(env)
      expect(r.code).toBe(0)
      expect(calls()).toBe(proceeds ? 1 : 0)
    })
  })

  describe('claude 呼叫', () => {
    it('旗標與預設值', async () => {
      await run()
      const a = argv()
      expect(a).toContain('-p')
      expect(flag('--permission-mode')).toBe('dontAsk')
      expect(flag('--tools')).toBe('Read,Edit,Write,Glob,Grep')
      expect(flag('--allowedTools')).toBe('Read,Glob,Grep,Edit(./**)')
      const di = a.indexOf('--disallowedTools')
      expect(a.slice(di + 1, di + 4)).toEqual(['Edit(**/.git/**)', 'Write(**/.git/**)', 'Read(**/.git/**)'])
      const settings = JSON.parse(flag('--settings')!)
      expect(settings.permissions.blockWritesOutsideWorkingDirectories).toBe(true)
      expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true)
      expect(flag('--model')).toBe('claude-opus-5-5')
      expect(flag('--max-budget-usd')).toBe('5')
      expect(flag('--max-turns')).toBe('40')
      expect(flag('--output-format')).toBe('json')
      expect(flag('--setting-sources')).toBe('user')
      expect(a).not.toContain('--dangerously-skip-permissions')
      expect(a).not.toContain('--bare')
      const schema = JSON.parse(flag('--json-schema')!)
      expect(schema.required).toEqual(['fixed', 'target', 'rootCause', 'changeSummary', 'prTitle', 'verificationNotes'])
      expect(schema.properties.target.enum).toEqual(['test', 'app', 'both'])
    })

    it('AI_FIX_MODEL／AI_FIX_MAX_BUDGET_USD／AI_FIX_MAX_TURNS 覆寫生效', async () => {
      await run({ AI_FIX_MODEL: 'claude-sonnet-5-5', AI_FIX_MAX_BUDGET_USD: '2', AI_FIX_MAX_TURNS: '10' })
      expect(flag('--model')).toBe('claude-sonnet-5-5')
      expect(flag('--max-budget-usd')).toBe('2')
      expect(flag('--max-turns')).toBe('10')
    })

    it('agent env 不含機密、含認證變數，identity token 檔為 0600', async () => {
      await run()
      const { env, token } = agentEnv()
      for (const k of ['GH_TOKEN', 'BEACON_SECRET', 'TRUSTNEL_E2E_PASSWORD', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'])
        expect(env).not.toHaveProperty(k)
      expect(env).toMatchObject({
        ANTHROPIC_FEDERATION_RULE_ID: 'fr_1',
        ANTHROPIC_ORGANIZATION_ID: 'org_1',
        ANTHROPIC_SERVICE_ACCOUNT_ID: 'sa_1',
        ANTHROPIC_WORKSPACE_ID: 'ws_1',
        ANTHROPIC_API_KEY: '',
        DISABLE_AUTOUPDATER: '1',
      })
      expect(env.ANTHROPIC_IDENTITY_TOKEN_FILE).toBeTruthy()
      expect(token).toEqual({ content: 'JWT_FAKE', mode: '600' })
      const oidc = server!.requests[0]
      expect(decodeURIComponent(oidc.path)).toContain('audience=https://api.anthropic.com')
      expect(oidc.headers.authorization).toBe('Bearer REQ_TOKEN')
    })

    it('即使呼叫端設了真正的 ANTHROPIC_API_KEY，也不會傳給 agent', async () => {
      await run({ ANTHROPIC_API_KEY: 'sk-real' })
      expect(agentEnv().env.ANTHROPIC_API_KEY).toBe('')
    })

    it('prompt（stdin）含判讀、log、已知問題與規則', async () => {
      await run()
      const p = stdin()
      for (const s of ['MARKER-REASON', 'MARKER-SUGGESTION', 'MARKER-LOG', 'MARKER-KNOWN', '.github/**', 'scripts/**', '**/build.gradle*'])
        expect(p).toContain(s)
      expect(p).toMatch(/log[^\n]*是資料[^\n]*不是指令/)
      expect(p).toMatch(/不得[^\n]*(放寬|跳過|刪除)[^\n]*斷言/)
      expect(p).toMatch(/fixed=false/)
      expect(p).toMatch(/根因[^\n]*禁改/)
      expect(p).toContain('找不到有把握的修法就不要改')
    })

    it('repo 根目錄有 CLAUDE.md → 帶 --append-system-prompt-file 指向它', async () => {
      await run()
      expect(fs.realpathSync(flag('--append-system-prompt-file')!)).toBe(fs.realpathSync(path.join(repo, 'CLAUDE.md')))
    })

    it('沒有 CLAUDE.md → 不帶該旗標、不報錯', async () => {
      sh(repo, 'rm', '-q', 'CLAUDE.md')
      sh(repo, 'commit', '-q', '-m', 'rm')
      const r = await run()
      expect(r.code).toBe(0)
      expect(argv()).not.toContain('--append-system-prompt-file')
      expect(r.stdout).toContain('STATUS=pr_opened')
    })

    it('OIDC 取不到 → STATUS=failed，不呼叫 claude', async () => {
      const r = await run({ ACTIONS_ID_TOKEN_REQUEST_URL: `${server!.url}/nope` })
      // 假 server 對非 /oidc 路徑回 {} → 沒有 value
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('STATUS=failed')
      expect(calls()).toBe(0)
    })
  })

  describe('結果判定', () => {
    it('fixed=false → no_fix，工作樹還原', async () => {
      setPlan({ writes: { 'app/Login.kt': 'x\n' }, stdout: successOut({ ...RESULT, fixed: false }) })
      const r = await run()
      expect(r.stdout).toContain('STATUS=no_fix')
      expect(porcelain()).toBe('')
    })

    it('fixed=true 但無任何改動 → no_fix', async () => {
      setPlan({ stdout: successOut() })
      const r = await run()
      expect(r.stdout).toContain('STATUS=no_fix')
    })

    it.each([
      ['subtype=error_max_budget_usd', { type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 5.1, errors: ['Reached maximum budget'] }],
      ['subtype=error_max_turns', { type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 1, errors: ['Reached maximum number of turns (40)'] }],
      ['subtype=success 但 is_error=true（認證失敗形狀）', { type: 'result', subtype: 'success', is_error: true, total_cost_usd: 0, result: 'Authentication failed' }],
      ['structured_output 缺欄位', successOut({ fixed: true, target: 'test' })],
      ['target 非三值', successOut({ ...RESULT, target: 'docs' })],
      ['stdout 非 JSON', 'oops not json'],
    ])('%s → failed，改動丟棄', async (_n, stdout) => {
      setPlan({ writes: { 'app/Login.kt': 'x\n' }, stdout, exitCode: 1 })
      const r = await run()
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('STATUS=failed')
      expect(porcelain()).toBe('')
    })

    it('失敗時也取 total_cost_usd', async () => {
      setPlan({ stdout: { type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 1.5 } })
      const r = await run()
      expect(r.stdout).toContain('COST_USD=1.5')
    })

    it('claude 非零退出但輸出成功 JSON → 仍照解析（不依賴 exit code）', async () => {
      setPlan({ writes: { 'app/Login.kt': 'x\n' }, stdout: successOut(), exitCode: 1 })
      const r = await run()
      expect(r.stdout).toContain('STATUS=pr_opened')
    })
  })

  describe('越界檢查', () => {
    it.each([
      '.github/workflows/ci.yml',
      'scripts/e2e.sh',
      'scripts/ci-e2e-run.sh',
      'app/release.keystore',
      'x.jks',
      'x.p12',
      'x.mobileprovision',
      '.env.production',
      'phone/google-services.json',
      'ios/GoogleService-Info.plist',
      'phone/build.gradle.kts',
      'settings.gradle.kts',
      'gradle/wrapper/gradle-wrapper.properties',
      'gradle.properties',
      'gradlew',
      'gradlew.bat',
      'Sub/Package.swift',
      'Sub/Package.resolved',
      'App.xcodeproj/project.pbxproj',
      'App.xcworkspace/contents.xcworkspacedata',
      'Podfile',
      'Podfile.lock',
      'Config/Debug.xcconfig',
    ])('改 %s → failed 且工作樹乾淨', async (p) => {
      setPlan({ writes: { 'app/Login.kt': 'x\n', [p]: 'evil\n' }, stdout: successOut() })
      const r = await run()
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('STATUS=failed')
      expect(porcelain()).toBe('')
    })

    it('AI_FIX_DENY_PATHS 追加', async () => {
      setPlan({ writes: { 'docs/a.md': 'x\n' }, stdout: successOut() })
      expect((await run()).stdout).toContain('STATUS=pr_opened')
      setPlan({ writes: { 'docs/a.md': 'y\n' }, stdout: successOut() })
      const r = await run({ AI_FIX_DENY_PATHS: 'docs/**' })
      expect(r.stdout).toContain('STATUS=failed')
      expect(porcelain()).toBe('')
    })

    it.each(['app/Login.kt', 'phone/src/androidTest/LoginTest.kt', 'TrustnelApp-iOS/TrustnelAppUITests/A.swift'])(
      '允許路徑 %s → 通過（pr_opened）',
      async (p) => {
        setPlan({ writes: { [p]: 'changed\n' }, stdout: successOut() })
        const r = await run()
        expect(r.stdout).toContain('STATUS=pr_opened')
      },
    )

    it.each(['scripts/測試 a.sh', '.GitHub/workflows/x.yml'])('特殊路徑 %s 被擋', async (p) => {
      setPlan({ writes: { [p]: 'x\n' }, stdout: successOut() })
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(porcelain()).toBe('')
    })

    it('把 app/Login.kt 改名為 scripts/Login.kt 被擋', async () => {
      setPlan({ renames: [['app/Login.kt', 'scripts/Login.kt']], stdout: successOut() })
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(porcelain()).toBe('')
      expect(fs.existsSync(path.join(repo, 'app/Login.kt'))).toBe(true)
    })

    const manyFiles = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`app/f${i}.kt`, 'x\n']))
    it.each([
      [20, 'pr_opened', {}],
      [21, 'failed', {}],
      [5, 'pr_opened', { AI_FIX_MAX_FILES: '5' }],
      [6, 'failed', { AI_FIX_MAX_FILES: '5' }],
    ])('%i 個檔案（%j）→ %s', async (n, expected, env) => {
      setPlan({ writes: manyFiles(n as number), stdout: successOut() })
      const r = await run(env as Record<string, string>)
      expect(r.stdout).toContain(`STATUS=${expected}`)
      if (expected === 'failed') expect(porcelain()).toBe('')
    })

    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n'
    it.each([
      [600, 'pr_opened', {}],
      [601, 'failed', {}],
      [10, 'pr_opened', { AI_FIX_MAX_LINES: '10' }],
      [11, 'failed', { AI_FIX_MAX_LINES: '10' }],
    ])('%i 行（新增）→ %s', async (n, expected, env) => {
      setPlan({ writes: { 'app/Big.kt': lines(n as number) }, stdout: successOut() })
      const r = await run(env as Record<string, string>)
      expect(r.stdout).toContain(`STATUS=${expected}`)
    })

    it('行數為新增＋刪除', async () => {
      // 原檔 1 行被改成 300 行：新增 300＋刪除 1；再加另一檔 300 行 → 601
      setPlan({ writes: { 'app/Login.kt': lines(300), 'app/B.kt': lines(300) }, stdout: successOut() })
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
    })
  })

  describe('乾跑', () => {
    it('AI_FIX_DRY_RUN=1：印 diff 與 PR 標題／描述，不推送、不開 PR、不回報', async () => {
      const r = await run({ AI_FIX_DRY_RUN: '1', ...beacon() })
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('+class Login2')
      expect(r.stdout).toContain('[AI fix] 更新登入頁 selector')
      expect(r.stdout).toContain('https://github.com/o/r/actions/runs/1')
      expect(r.stdout).toContain('登入頁 selector 已改名')
      expect(r.stdout).toContain('未經 E2E 驗證')
      expect(sh(repo, 'ls-remote', '--heads', 'origin', 'ai-fix/*').trim()).toBe('')
      expect(ghLog().some((a) => a[1] === 'create')).toBe(false)
      expect(server!.requests.filter((q) => q.path.startsWith('/api/'))).toHaveLength(0)
    })
  })

  describe('安全防護（fix round 1）', () => {
    const gitConfig = () => fs.readFileSync(path.join(repo, '.git/config'), 'utf8')

    it('agent 改 .git/config 的 core.fsmonitor → failed、指令未執行、config 已還原', async () => {
      const orig = gitConfig()
      const marker = path.join(dir, 'fsmonitor-ran')
      setPlan({
        writes: { 'app/Login.kt': 'x\n', '.git/config': `${orig}[core]\n\tfsmonitor = touch ${marker}; false\n` },
        stdout: successOut(),
      })
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(fs.existsSync(marker)).toBe(false)
      expect(gitConfig()).toBe(orig)
      expect(porcelain()).toBe('')
    })

    it('agent 寫 .git/hooks/pre-commit → failed 且 hook 已移除', async () => {
      setPlan({ writes: { 'app/Login.kt': 'x\n', '.git/hooks/pre-commit': '#!/bin/sh\necho pwned\n' }, stdout: successOut() })
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(fs.existsSync(path.join(repo, '.git/hooks/pre-commit'))).toBe(false)
    })

    it('agent 建立巢狀 sub/.git/ → failed 且工作樹乾淨', async () => {
      setPlan({ writes: { 'sub/.git/HEAD': 'ref: refs/heads/x\n', 'sub/a.txt': 'x\n' }, stdout: successOut() })
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(porcelain()).toBe('')
      expect(fs.existsSync(path.join(repo, 'sub/.git'))).toBe(false)
    })

    it('被 gitignore 的新檔視為越界並刪除；執行前已存在的被忽略檔保留', async () => {
      put('.gitignore', '.env*\nbuild/\n')
      sh(repo, 'add', '.gitignore')
      sh(repo, 'commit', '-q', '-m', 'ignore')
      put('build/keep.txt', 'keep\n')
      for (const p of ['.env.production', 'build/x.txt']) {
        setPlan({ writes: { 'app/Login.kt': 'x\n', [p]: 'secret\n' }, stdout: successOut() })
        const r = await run()
        expect(r.stdout).toContain('STATUS=failed')
        expect(fs.existsSync(path.join(repo, p))).toBe(false)
        expect(porcelain()).toBe('')
      }
      expect(fs.readFileSync(path.join(repo, 'build/keep.txt'), 'utf8')).toBe('keep\n')
    })

    it('fixed=false 時被忽略的新檔也會清掉', async () => {
      put('.gitignore', 'build/\n')
      sh(repo, 'add', '.gitignore')
      sh(repo, 'commit', '-q', '-m', 'ignore')
      setPlan({ writes: { 'build/x.txt': 'x\n' }, stdout: successOut({ ...RESULT, fixed: false }) })
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(fs.existsSync(path.join(repo, 'build/x.txt'))).toBe(false)
    })

    it('docs/ 已有檔案時，追加 docs/** 仍擋得住新檔（不被 pathname expansion 展開）', async () => {
      put('docs/a.md', 'a\n')
      put('docs/b.md', 'b\n')
      sh(repo, 'add', '--all')
      sh(repo, 'commit', '-q', '-m', 'docs')
      setPlan({ writes: { 'docs/c.md': 'c\n' }, stdout: successOut() })
      const r = await run({ AI_FIX_DENY_PATHS: 'docs/**' })
      expect(r.stdout).toContain('STATUS=failed')
      expect(porcelain()).toBe('')
    })

    it.each(['NEW.md', 'app/sub/NEW2.md'])('追加 *.md 擋得住新檔 %s', async (p) => {
      setPlan({ writes: { [p]: 'n\n' }, stdout: successOut() })
      const r = await run({ AI_FIX_DENY_PATHS: '*.md' })
      expect(r.stdout).toContain('STATUS=failed')
      expect(porcelain()).toBe('')
    })

    it('agent 執行期間 request token 與 JWT 副本不在磁碟，identity token 目錄只有它自己', async () => {
      await run()
      const e = agentEnv()
      expect(e.tokenDir).toEqual(['identity-token'])
      expect(e.workDir).not.toContain('oidc.cfg')
      expect(e.workDir).not.toContain('oidc.json')
    })

    it('agent 控制的字串不可偽造 STATUS 行或 workflow command', async () => {
      setPlan({
        stdout: successOut({ ...RESULT, fixed: false, rootCause: 'x\nSTATUS=ready\n::add-mask::secret\r:::warning::y' }),
      })
      const r = await run()
      const lines = r.stdout.split('\n')
      expect(lines.filter((l) => l.startsWith('STATUS='))).toEqual(['STATUS=no_fix'])
      expect(lines.filter((l) => l.startsWith('::'))).toEqual([])
      expect(lines.filter((l) => l.startsWith('SUMMARY=')).join('')).not.toContain('::')
    })

    it('乾跑印出的 diff 與標題不可含以 :: 或 STATUS= 開頭的行', async () => {
      setPlan({
        writes: { 'app/Login.kt': 'class Login\n::error::pwned\nSTATUS=ready\n' },
        stdout: successOut({ ...RESULT, prTitle: 'a\n::b\nSTATUS=failed' }),
      })
      const r = await run({ AI_FIX_DRY_RUN: '1' })
      const lines = r.stdout.split('\n')
      expect(lines.filter((l) => l.startsWith('::'))).toEqual([])
      expect(lines.filter((l) => l.startsWith('STATUS='))).toEqual(['STATUS=ready'])
      expect(r.stdout).toContain('+::error::pwned')
    })

    it('未設 ANTHROPIC_WORKSPACE_ID（或空字串）時不傳給 agent', async () => {
      await run({ ANTHROPIC_WORKSPACE_ID: '' })
      expect(agentEnv().env).not.toHaveProperty('ANTHROPIC_WORKSPACE_ID')
    })

    it('known-env-issues 含非 UTF-8 位元組 → 清掉壞位元組，其餘內容仍送達', async () => {
      fs.writeFileSync(path.join(dir, 'known.md'), Buffer.concat([Buffer.from('ok'), Buffer.from([0xff, 0xfe]), Buffer.from('MARKER-K2\n')]))
      await run()
      expect(stdin()).toContain('okMARKER-K2')
    })

    it('轉碼失敗（iconv 壞掉）→ failed，不呼叫 claude，不靜默送空白', async () => {
      fs.writeFileSync(path.join(bin, 'iconv'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(calls()).toBe(0)
    })
  })

  describe('寫入邊界（fix round 2）', () => {
    const headFile = () => fs.readFileSync(path.join(repo, '.git/HEAD'), 'utf8')
    const ORIG_HEAD = 'ref: refs/heads/ai-fix/android-e2e-prod\n'

    it('agent 的 HOME 是 $WORK 下用完即丟的目錄，不是呼叫端的 HOME，結束後已清除', async () => {
      await run()
      const h = agentEnv().env.HOME
      expect(h).toBeTruthy()
      expect(h).not.toBe(process.env.HOME)
      expect(h).toContain('ai-fix.')
      expect(fs.existsSync(h)).toBe(false)
    })

    it('agent 寫 .git/commondir → failed、檔案移除、git-common-dir 仍為原值', async () => {
      const before = sh(repo, 'rev-parse', '--git-common-dir').trim()
      const elsewhere = path.join(dir, 'elsewhere')
      fs.mkdirSync(elsewhere)
      setPlan({ writes: { 'app/Login.kt': 'x\n', '.git/commondir': elsewhere + '\n' }, stdout: successOut() })
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(fs.existsSync(path.join(repo, '.git/commondir'))).toBe(false)
      expect(sh(repo, 'rev-parse', '--git-common-dir').trim()).toBe(before)
    })

    it('agent 改 .git/HEAD → failed 且還原', async () => {
      setPlan({ writes: { 'app/Login.kt': 'x\n', '.git/HEAD': 'ref: refs/heads/other\n' }, stdout: successOut() })
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(headFile()).toBe(ORIG_HEAD)
      expect(sh(repo, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/ai-fix/android-e2e-prod')
    })

    it('agent 新增 .git/worktrees/x/gitdir → failed 且移除', async () => {
      setPlan({ writes: { 'app/Login.kt': 'x\n', '.git/worktrees/x/gitdir': '/tmp/evil/.git\n' }, stdout: successOut() })
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(fs.existsSync(path.join(repo, '.git/worktrees'))).toBe(false)
    })

    it('全域 git 設定的 fsmonitor／clean filter 不會被腳本的 git 指令執行', async () => {
      const marker = path.join(dir, 'global-fsmonitor-ran')
      const gc = path.join(dir, 'global.gitconfig')
      const attrs = path.join(dir, 'global.attributes')
      fs.writeFileSync(attrs, '* filter=pwn\n')
      fs.writeFileSync(
        gc,
        `[core]\n\tfsmonitor = touch ${marker}; false\n\tattributesFile = ${attrs}\n[filter "pwn"]\n\tclean = touch ${marker}; cat\n`,
      )
      const r = await run({ GIT_CONFIG_GLOBAL: gc })
      expect(r.stdout).toContain('STATUS=pr_opened')
      expect(fs.existsSync(marker)).toBe(false)
    })
  })
  describe('commit 與 PR（7b）', () => {
    it('成功：commit 作者 <slug>[bot]，origin 出現 ai-fix 分支，只含 agent 改的檔案，父 commit 為原 HEAD', async () => {
      const before = sh(repo, 'rev-parse', 'HEAD').trim()
      const r = await run({ AI_FIX_APP_SLUG: 'my-app', AI_FIX_APP_USER_ID: '123' })
      expect(r.stdout).toContain('STATUS=pr_opened')
      expect(sh(origin, 'log', '-1', '--format=%an <%ae>', branchRef).trim()).toBe('my-app[bot] <123+my-app[bot]@users.noreply.github.com>')
      expect(sh(origin, 'log', '-1', '--format=%s', branchRef).trim()).toBe('[AI fix] 更新登入頁 selector')
      expect(sh(origin, 'show', '--name-only', '--format=', branchRef).trim()).toBe('app/Login.kt')
      expect(sh(origin, 'rev-parse', `${branchRef}^`).trim()).toBe(before)
    })

    it('沒有 AI_FIX_APP_USER_ID／AI_FIX_APP_SLUG 時 email 與作者仍合理', async () => {
      await run({ AI_FIX_APP_SLUG: 'my-app' })
      expect(sh(origin, 'log', '-1', '--format=%ae', branchRef).trim()).toBe('my-app[bot]@users.noreply.github.com')
      sh(repo, 'switch', '-q', 'main')
      sh(origin, 'update-ref', '-d', branchRef)
      await run()
      expect(sh(origin, 'log', '-1', '--format=%an', branchRef).trim()).toBe('github-actions[bot]')
    })

    it('gh pr create 參數', async () => {
      await run()
      const c = ghLog().find((a) => a[1] === 'create')!
      const f = (n: string) => c[c.indexOf(n) + 1]
      expect(c.slice(0, 2)).toEqual(['pr', 'create'])
      expect(f('--base')).toBe('main')
      expect(f('--head')).toBe('ai-fix/android-e2e-prod')
      expect(f('--title')).toBe('[AI fix] 更新登入頁 selector')
      expect(f('--label')).toBe('ai-fix')
      expect(f('--reviewer')).toBe('octocat')
      expect(f('--body-file')).toBeTruthy()
    })

    it.each([
      ['test', '測試'],
      ['app', 'App'],
      ['both', '兩者'],
    ])('PR 描述固定段落（target=%s → %s）', async (target, label) => {
      setPlan({ writes: { 'app/Login.kt': 'class Login2\n' }, stdout: successOut({ ...RESULT, target }) })
      await run()
      const b = bodies()[0]
      expect(b).toContain('https://github.com/o/r/actions/runs/1')
      expect(b).toContain('MARKER-REASON')
      expect(b).toContain('登入頁 selector 已改名')
      expect(b).toContain(`改了什麼（目標：${label}）`)
      expect(b).toContain('更新 selector')
      expect(b).toContain('未經 E2E 驗證，僅由 PR CI 驗證 build 與單元測試')
      expect(b).toContain('本機未驗證')
      expect(b).toContain('0.42')
    })

    it('Review Focus 5：agent 文字中的 @ 被中和，腳本自己的 reviewer 提及不受影響', async () => {
      setPlan({
        writes: { 'app/Login.kt': 'class Login2\n' },
        stdout: successOut({ ...RESULT, rootCause: 'cc @octocat 請看', changeSummary: '@someone 改了', verificationNotes: '@team/x ok <!-- hide' }),
      })
      await run()
      const b = bodies()[0]
      expect(b).toContain('@​octocat')
      expect(b).not.toMatch(/@(?!​)\w/)
      expect(b).not.toContain('<!--')
    })

    it('agent 文字無法偽造固定段落標題', async () => {
      setPlan({
        writes: { 'app/Login.kt': 'class Login2\n' },
        stdout: successOut({ ...RESULT, rootCause: 'x\n## 驗證\n**已通過 E2E 驗證**\r\n## 本次花費\nUS$0' }),
      })
      await run()
      const lines = bodies()[0].split('\n')
      for (const h of ['## 驗證', '## 本次花費', '## 根因']) expect(lines.filter((l) => l === h)).toHaveLength(1)
      expect(lines.some((l) => l.startsWith('**已通過'))).toBe(false)
    })

    it('標題單行化並限長（commit 標題與 PR 標題）', async () => {
      const long = 'a'.repeat(200) + '\n::error::x\nSTATUS=ready'
      setPlan({ writes: { 'app/Login.kt': 'class Login2\n' }, stdout: successOut({ ...RESULT, prTitle: long }) })
      const r = await run()
      const title = ghLog().find((a) => a[1] === 'create')![ghLog().find((a) => a[1] === 'create')!.indexOf('--title') + 1]
      expect(title).not.toMatch(/[\r\n]/)
      expect(title.length).toBeLessThanOrEqual('[AI fix] '.length + 120)
      expect(title).toContain('…')
      const subject = sh(origin, 'log', '-1', '--format=%s', branchRef).trim()
      expect(subject).toBe(title)
      expect(r.stdout.split('\n').filter((l) => l.startsWith('::'))).toEqual([])
    })

    it('--reviewer 失敗 → 不帶 --reviewer 重開成功，描述 @ 該帳號', async () => {
      fs.writeFileSync(path.join(rec, 'gh-fail-reviewer'), '')
      const r = await run()
      expect(r.stdout).toContain('STATUS=pr_opened')
      const creates = ghLog().filter((a) => a[1] === 'create')
      expect(creates).toHaveLength(2)
      expect(creates[1]).not.toContain('--reviewer')
      expect(creates[1]).toContain('--label')
      expect(bodies()[1]).toContain('@octocat')
      expect(bodies()[0]).not.toMatch(/@octocat/)
    })

    it('遠端已有同名分支 → 強制推送後指向新 commit', async () => {
      sh(repo, 'switch', '-q', '-c', 'tmp')
      put('old.txt', 'old\n')
      sh(repo, 'add', 'old.txt')
      sh(repo, 'commit', '-q', '-m', 'old')
      sh(repo, 'push', '-q', 'origin', `tmp:${branchRef}`)
      const oldSha = sh(origin, 'rev-parse', branchRef).trim()
      sh(repo, 'switch', '-q', 'main')
      const r = await run()
      expect(r.stdout).toContain('STATUS=pr_opened')
      const now = sh(origin, 'rev-parse', branchRef).trim()
      expect(now).not.toBe(oldSha)
      expect(sh(origin, 'log', '-1', '--format=%s', branchRef).trim()).toBe('[AI fix] 更新登入頁 selector')
    })

    it('push 被 remote 拒絕 → failed，不呼叫 gh pr create', async () => {
      fs.writeFileSync(path.join(origin, 'hooks/pre-receive'), '#!/bin/sh\necho "rejected by hook" >&2\nexit 1\n', { mode: 0o755 })
      const r = await run()
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('STATUS=failed')
      expect(ghLog().some((a) => a[1] === 'create')).toBe(false)
    })

    it('gh pr create 兩次都失敗 → failed，summary 註明分支已推送', async () => {
      fs.writeFileSync(path.join(rec, 'gh-fail-all'), '')
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(r.stdout).toMatch(/SUMMARY=.*已推送.*ai-fix\/android-e2e-prod/)
      expect(sh(origin, 'rev-parse', branchRef).trim()).toMatch(/^[0-9a-f]{40}$/)
      expect(ghLog().filter((a) => a[1] === 'create')).toHaveLength(2)
    })

    it('gh pr create 失敗但 PR 其實已存在 → 取得該 PR 網址，視為 pr_opened', async () => {
      fs.writeFileSync(path.join(rec, 'gh-fail-all'), '')
      setOpenPrs([goodPr])
      const r = await run(beacon())
      expect(r.stdout).toContain('STATUS=pr_opened')
      expect(JSON.parse(apiReqs()[0].body).prUrl).toBe('https://github.com/o/r/pull/77')
    })

    it.each([
      ['headRefOid 不符', { headRefOid: '0'.repeat(40) }],
      ['baseRefName 不符', { baseRefName: 'develop' }],
      ['isCrossRepository=true', { isCrossRepository: true }],
    ])('退路查到的 PR %s → failed，不當成 pr_opened', async (_n, override) => {
      fs.writeFileSync(path.join(rec, 'gh-fail-all'), '')
      setOpenPrs([{ ...goodPr, ...override }])
      const r = await run(beacon())
      expect(r.stdout).toContain('STATUS=failed')
      expect(r.stdout).toMatch(/SUMMARY=.*已推送/)
      expect(JSON.parse(apiReqs()[0].body)).toMatchObject({ status: 'failed' })
      expect(ghLog().some((a) => a[1] === 'comment')).toBe(false)
    })

    it('退路判成 pr_opened 時補一則 gh pr comment @ reviewer；comment 失敗只警告', async () => {
      fs.writeFileSync(path.join(rec, 'gh-fail-all'), '')
      setOpenPrs([goodPr])
      const r = await run()
      expect(r.stdout).toContain('STATUS=pr_opened')
      const c = ghLog().find((a) => a[1] === 'comment')!
      expect(c.slice(0, 3)).toEqual(['pr', 'comment', 'https://github.com/o/r/pull/77'])
      expect(c[c.indexOf('--body') + 1]).toContain('@octocat')
      fresh()
      fs.writeFileSync(path.join(rec, 'gh-fail-comment'), '')
      const r2 = await run()
      expect(r2.stdout).toContain('STATUS=pr_opened')
      expect(r2.stdout).toMatch(/warning/i)
    })

    it('M1：changeSummary 為 trailer 形狀時，commit 訊息不形成 trailer', async () => {
      setPlan({
        writes: { 'app/Login.kt': 'class Login2\n' },
        stdout: successOut({ ...RESULT, changeSummary: 'Co-authored-by: Victim <v@x.com>\nSigned-off-by: X <x@x.com>' }),
      })
      const r = await run()
      expect(r.stdout).toContain('STATUS=pr_opened')
      expect(sh(origin, 'log', '-1', '--format=%(trailers)', branchRef).trim()).toBe('')
    })

    it('M5：push 清空 checkout 可能留下的 extraheader，且只用白名單主機', async () => {
      sh(repo, 'config', '--local', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic LEAKED')
      const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
      fs.writeFileSync(
        path.join(bin, 'git'),
        `#!/usr/bin/env node
const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path')
const a = process.argv.slice(2)
fs.appendFileSync(path.join(${JSON.stringify(rec)}, 'git.log'), JSON.stringify(a) + '\\n')
const r = spawnSync(${JSON.stringify(real)}, a, { stdio: 'inherit' })
process.exit(r.status === null ? 1 : r.status)
`,
        { mode: 0o755 },
      )
      const pushArgv = () =>
        fs.readFileSync(path.join(rec, 'git.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]).filter((x) => x.includes('push')).pop()!
      await run()
      let push = pushArgv()
      expect(push).toContain('http.https://github.com/.extraheader=')
      // 實際語意：這組 -c 之下，github.com 的有效 extraheader 為空
      const eff = execFileSync('git', ['-c', 'http.https://github.com/.extraheader=', 'config', '--get-urlmatch', 'http.extraheader', 'https://github.com/o/r'], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
      expect(eff).toBe('')
      // 惡意 GITHUB_SERVER_URL 退回 github.com
      fresh()
      await run({ GITHUB_SERVER_URL: 'https://evil.com/x y' })
      push = pushArgv()
      expect(push.some((x) => x.startsWith('credential.https://github.com.helper='))).toBe(true)
      expect(push.some((x) => x.includes('evil.com'))).toBe(false)
    })

    it('push 的 git 呼叫 argv 不含 GH_TOKEN／BEACON_SECRET，憑證由 helper 從環境變數取', async () => {
      const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
      fs.writeFileSync(
        path.join(bin, 'git'),
        `#!/usr/bin/env node
const { spawnSync } = require('child_process'), fs = require('fs'), path = require('path')
const a = process.argv.slice(2)
fs.appendFileSync(path.join(${JSON.stringify(rec)}, 'git.log'), JSON.stringify(a) + '\\n')
const r = spawnSync(${JSON.stringify(real)}, a, { stdio: 'inherit' })
process.exit(r.status === null ? 1 : r.status)
`,
        { mode: 0o755 },
      )
      const r = await run(beacon())
      expect(r.stdout).toContain('STATUS=pr_opened')
      const log = fs.readFileSync(path.join(rec, 'git.log'), 'utf8')
      expect(log).not.toContain('ghs_SECRET')
      expect(log).not.toContain('beacon-secret')
      const push = log.split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]).find((a) => a.includes('push'))!
      expect(push).toEqual(expect.arrayContaining(['push', '--force', 'origin', `HEAD:${branchRef}`]))
      expect(push.some((x) => x === 'credential.helper=')).toBe(true)
      expect(push.some((x) => /^credential\.https:\/\/github\.com\.helper=!.*GH_TOKEN/.test(x))).toBe(true)
      expect(push).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null']))
      expect(fs.readFileSync(path.join(repo, '.git/config'), 'utf8')).not.toContain('ghs_SECRET')
      expect(r.stdout + r.stderr).not.toContain('ghs_SECRET')
    })

    it('commit 後父 commit 不是原 HEAD → failed，不 push', async () => {
      const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
      fs.writeFileSync(
        path.join(bin, 'git'),
        `#!/usr/bin/env node
const { spawnSync } = require('child_process')
const a = process.argv.slice(2)
if (a.includes('commit')) spawnSync(${JSON.stringify(real)}, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '--allow-empty', '-q', '-m', 'sneaky'], { stdio: 'ignore' })
const r = spawnSync(${JSON.stringify(real)}, a, { stdio: 'inherit' })
process.exit(r.status === null ? 1 : r.status)
`,
        { mode: 0o755 },
      )
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(sh(origin, 'for-each-ref', 'refs/heads').trim()).not.toContain('ai-fix')
      expect(ghLog().some((a) => a[1] === 'create')).toBe(false)
    })
  })

  describe('回報 th-beacon（7b）', () => {
    const sigOk = (q: { headers: Record<string, string | string[] | undefined>; body: string }) => {
      const ts = String(q.headers['x-beacon-timestamp'])
      const sig = createHmac('sha256', 'beacon-secret').update(`${ts}.${q.body}`).digest('hex')
      return q.headers['x-beacon-signature'] === `sha256=${sig}`
    }

    it('pr_opened：/api/ai-fix body、簽章、headers', async () => {
      const r = await run(beacon())
      expect(r.code).toBe(0)
      const q = apiReqs()[0]
      expect(q.method).toBe('POST')
      expect(q.path).toBe('/api/ai-fix')
      expect(q.headers['x-beacon-service']).toBe('svc-a')
      expect(q.headers['content-type']).toBe('application/json')
      expect(Math.abs(Number(q.headers['x-beacon-timestamp']) - Date.now() / 1000)).toBeLessThan(60)
      expect(sigOk(q)).toBe(true)
      expect(JSON.parse(q.body)).toEqual({
        heartbeat: 'android-e2e-prod',
        status: 'pr_opened',
        prUrl: 'https://github.com/o/r/pull/9',
        summary: '更新 selector；改的是測試',
        runUrl: 'https://github.com/o/r/actions/runs/1',
      })
    })

    it('/api/ai-usage body 為 ci_pr；no_fix 與 failed 也回報', async () => {
      await run(beacon())
      const u = apiReqs()[1]
      expect(u.path).toBe('/api/ai-usage')
      expect(sigOk(u)).toBe(true)
      expect(JSON.parse(u.body)).toEqual({ source: 'ci_pr', model: 'claude-opus-5-5', costUsd: 0.42 })

      server!.requests.length = 0
      setPlan({ stdout: successOut({ ...RESULT, fixed: false, rootCause: '根因在 scripts/e2e.sh' }) })
      await run(beacon())
      expect(apiReqs().map((x) => x.path)).toEqual(['/api/ai-fix', '/api/ai-usage'])
      expect(JSON.parse(apiReqs()[0].body)).toEqual({
        heartbeat: 'android-e2e-prod',
        status: 'no_fix',
        summary: '根因在 scripts/e2e.sh',
        runUrl: 'https://github.com/o/r/actions/runs/1',
      })

      server!.requests.length = 0
      setPlan({ writes: { 'scripts/e2e.sh': 'evil\n' }, stdout: successOut() })
      await run(beacon())
      expect(JSON.parse(apiReqs()[0].body)).toMatchObject({ status: 'failed' })
      expect(apiReqs()[1].path).toBe('/api/ai-usage')
    })

    it('total_cost_usd 缺失或非數字 → 不打 /api/ai-usage，仍打 /api/ai-fix', async () => {
      for (const cost of [undefined, 'abc', -1]) {
        server!.requests.length = 0
        const out = successOut() as Record<string, unknown>
        if (cost === undefined) delete out.total_cost_usd
        else out.total_cost_usd = cost
        setPlan({ writes: { 'app/Login.kt': `x${String(cost)}\n` }, stdout: out })
        sh(repo, 'switch', '-q', 'main')
        sh(origin, 'update-ref', '-d', branchRef)
        const r = await run(beacon())
        expect(r.stdout).toContain('STATUS=pr_opened')
        expect(apiReqs().map((x) => x.path)).toEqual(['/api/ai-fix'])
      }
    })

    it('summary 超長且含 emoji → 截到 500 以內，不切壞字元', async () => {
      setPlan({ writes: { 'app/Login.kt': 'class Login2\n' }, stdout: successOut({ ...RESULT, changeSummary: '😀'.repeat(400) }) })
      await run(beacon())
      const { summary } = JSON.parse(apiReqs()[0].body) as { summary: string }
      expect(summary.length).toBeLessThanOrEqual(500)
      expect(summary).not.toContain('�')
      expect(summary).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
      expect(summary).toContain('😀')
    })

    it.each([500, 404])('/api/ai-fix 回 %i → exit 0、有 warning，PR 已開不受影響', async (status) => {
      apiStatus = status
      const r = await run(beacon())
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('STATUS=pr_opened')
      expect(r.stdout).toMatch(/warning/i)
      expect(ghLog().some((a) => a[1] === 'create')).toBe(true)
    })

    it('連不上 beacon → exit 0、有 warning', async () => {
      const r = await run({ BEACON_BASE_URL: 'http://127.0.0.1:1', BEACON_SERVICE: 'svc-a' })
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('STATUS=pr_opened')
      expect(r.stdout).toMatch(/warning/i)
    })

    it('BEACON_BASE_URL 或 BEACON_SECRET 為空 → 不回報，其餘照跑', async () => {
      const r1 = await run({ BEACON_SERVICE: 'svc-a' })
      expect(r1.stdout).toContain('STATUS=pr_opened')
      fresh()
      const r2 = await run({ ...beacon(), BEACON_SECRET: '' })
      expect(r2.code).toBe(0)
      expect(r2.stdout).toContain('STATUS=pr_opened')
      expect(apiReqs()).toHaveLength(0)
    })

    it.each([
      ['BEACON_SERVICE 含不合法字元', { BEACON_SERVICE: 'bad name\nX-Evil: 1' }, 'BEACON_SERVICE'],
      ['BEACON_BASE_URL 為非本機 http', { BEACON_BASE_URL: 'http://evil.example.com' }, 'BEACON_BASE_URL'],
      ['BEACON_BASE_URL 含空白', { BEACON_BASE_URL: 'https://x.example.com/a b' }, 'BEACON_BASE_URL'],
    ])('M4：%s → 不回報、印 warning、其餘照跑', async (_n, env, name) => {
      const r = await run({ ...beacon(), ...env })
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('STATUS=pr_opened')
      expect(r.stdout).toMatch(new RegExp(`warning: invalid ${name}`))
      expect(apiReqs()).toHaveLength(0)
    })

    it('M4：http://localhost:<port> 允許回報', async () => {
      const r = await run({ ...beacon(), BEACON_BASE_URL: server!.url.replace('127.0.0.1', 'localhost') })
      expect(r.stdout).toContain('STATUS=pr_opened')
      expect(apiReqs().length).toBeGreaterThan(0)
    })

    it('BEACON_SECRET 與 GH_TOKEN 不出現在 stdout／stderr（成功與失敗）', async () => {
      const outs = [await run(beacon())]
      expect(outs[0].stdout).toContain('STATUS=pr_opened')
      fresh()
      apiStatus = 500
      outs.push(await run(beacon()))
      expect(outs[1].stdout).toContain('STATUS=pr_opened')
      expect(outs[1].stdout).toMatch(/warning/i)
      fresh()
      setPlan({ writes: { 'scripts/e2e.sh': 'evil\n' }, stdout: successOut() })
      outs.push(await run(beacon()))
      expect(outs[2].stdout).toContain('STATUS=failed')
      for (const o of outs) {
        expect(o.stdout + o.stderr).not.toContain('beacon-secret')
        expect(o.stdout + o.stderr).not.toContain('ghs_SECRET')
      }
    })

    it('乾跑：零請求、零 push、零 gh pr create', async () => {
      await run({ AI_FIX_DRY_RUN: '1', ...beacon() })
      expect(apiReqs()).toHaveLength(0)
      expect(sh(origin, 'for-each-ref', 'refs/heads').trim()).not.toContain('ai-fix')
      expect(ghLog().some((a) => a[1] === 'create')).toBe(false)
    })

    it('去重跳過：不回報、不印 STATUS', async () => {
      setPrList([{ number: 1, state: 'OPEN', mergedAt: null, closedAt: null }])
      const r = await run(beacon())
      expect(r.code).toBe(0)
      expect(r.stdout).not.toContain('STATUS=')
      expect(apiReqs()).toHaveLength(0)
    })
  })

  describe('7a 遺留修補', () => {
    it('.git 內有含連續換行的檔名 → 還原時不得誤刪整個 gitdir', async () => {
      setPlan({ writes: { 'app/Login.kt': 'x\n', '.git/weird\n\nname': 'x' }, stdout: successOut() })
      const r = await run()
      expect(r.stdout).toContain('STATUS=failed')
      expect(fs.existsSync(path.join(repo, '.git/HEAD'))).toBe(true)
      expect(sh(repo, 'rev-parse', 'HEAD').trim()).toMatch(/^[0-9a-f]{40}$/)
      expect(fs.readdirSync(path.join(repo, '.git')).some((f) => f.startsWith('weird'))).toBe(false)
    })

    it.each(['symlink', 'gitfile'])('.git 不是真實目錄（%s）→ failed，不呼叫 agent', async (kind) => {
      const real = path.join(dir, 'gitreal')
      fs.renameSync(path.join(repo, '.git'), real)
      if (kind === 'symlink') fs.symlinkSync(real, path.join(repo, '.git'))
      else fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${real}\n`)
      const r = await run()
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('STATUS=failed')
      expect(calls()).toBe(0)
      expect(server!.requests.filter((q) => q.path.startsWith('/oidc'))).toHaveLength(0)
      expect(ghLog()).toHaveLength(0)
    })

    it('腳本不再含過時的「只比對 .git/config、hooks、info」註解', () => {
      expect(fs.readFileSync(SCRIPT, 'utf8')).not.toContain('等設定類檔案：agent 前後比對雜湊')
    })
  })
})
