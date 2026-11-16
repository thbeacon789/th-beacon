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
  fs.writeFileSync(path.join(rec, 'env.json'), JSON.stringify({ env: process.env, token }))
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
if (a[0] === 'pr' && a[1] === 'list') process.stdout.write(fs.readFileSync(path.join(rec, 'gh-list.json'), 'utf8'))
else if (a[0] === 'pr' && a[1] === 'create') process.stdout.write('https://github.com/o/r/pull/9\\n')
`

describe('ai-fix-e2e-failure.sh', () => {
  let dir: string
  let repo: string
  let origin: string
  let rec: string
  let bin: string
  let server: FakeServer | undefined

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
    server = await startServer((req) => (req.path.startsWith('/oidc') ? { json: { value: 'JWT_FAKE' } } : { json: {} }))
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
      expect(flag('--allowedTools')).toBe('Read,Edit,Write,Glob,Grep')
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
      expect(r.stdout).toContain('STATUS=ready')
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
      expect(r.stdout).toContain('STATUS=ready')
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
      expect((await run()).stdout).toContain('STATUS=ready')
      sh(repo, 'reset', '--hard', '-q')
      sh(repo, 'clean', '-fdq')
      const r = await run({ AI_FIX_DENY_PATHS: 'docs/**' })
      expect(r.stdout).toContain('STATUS=failed')
      expect(porcelain()).toBe('')
    })

    it.each(['app/Login.kt', 'phone/src/androidTest/LoginTest.kt', 'TrustnelApp-iOS/TrustnelAppUITests/A.swift'])(
      '允許路徑 %s → ready',
      async (p) => {
        setPlan({ writes: { [p]: 'changed\n' }, stdout: successOut() })
        const r = await run()
        expect(r.stdout).toContain('STATUS=ready')
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
      [20, 'ready', {}],
      [21, 'failed', {}],
      [5, 'ready', { AI_FIX_MAX_FILES: '5' }],
      [6, 'failed', { AI_FIX_MAX_FILES: '5' }],
    ])('%i 個檔案（%j）→ %s', async (n, expected, env) => {
      setPlan({ writes: manyFiles(n as number), stdout: successOut() })
      const r = await run(env as Record<string, string>)
      expect(r.stdout).toContain(`STATUS=${expected}`)
      if (expected === 'failed') expect(porcelain()).toBe('')
    })

    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n'
    it.each([
      [600, 'ready', {}],
      [601, 'failed', {}],
      [10, 'ready', { AI_FIX_MAX_LINES: '10' }],
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
      const r = await run({ AI_FIX_DRY_RUN: '1' })
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
})
