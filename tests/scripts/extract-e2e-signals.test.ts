import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runBash } from './helpers'

const EXTRACT = path.resolve(__dirname, '../../scripts/extract-e2e-signals.sh')
const DIAGNOSE = path.resolve(__dirname, '../../scripts/diagnose-e2e-failure.sh')
// 2026-11-25 Android E2E 真實 logcat 的子集（含 CalledFromWrongThread 區塊、THREAD_STATE dump、FATAL 崩潰、TrustnelE2E 標記）
const FIXTURE = path.resolve(__dirname, 'fixtures/android-logcat-1125.txt')
// 完整 4MB 原檔只在作者本機的 scratchpad，不進 repo；不存在就略過那一條
const REAL_LOGCAT =
  '/private/tmp/claude-501/-Users-navibluer-Code-ACTIVE-trustnel/8a6b4496-8787-4cb6-a658-be24a22da7ed/scratchpad/e2e-1125/art/e2e-prod-reports/_temp/logcat.txt'

const CAP = 30000

describe('fixture 衛生', () => {
  it('不含帳密／URL／金鑰字樣', () => {
    const t = fs.readFileSync(FIXTURE, 'utf8')
    for (const re of [/supabase/i, /eyJ/, /https?:\/\//i, /@/, /api[_-]?key/i, /secret/i, /password/i, /token/i]) {
      expect(t).not.toMatch(re)
    }
  })
})

describe('extract-e2e-signals.sh', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signals-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const write = (name: string, content: string | Buffer) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, content)
    return p
  }
  const extract = (platform: string, files: string[], env: Record<string, string> = {}) =>
    runBash(EXTRACT, [platform, ...files], env)

  it('(a) android：含真因例外與 App frame、時間軸，不含 THREAD_STATE，大小在上限內', async () => {
    const r = await extract('android', [FIXTURE])
    expect(r.code).toBe(0)
    const out = r.stdout
    expect(out).toContain('CalledFromWrongThreadException')
    expect(out).toContain('Error was captured in composition')
    expect(out).toContain('PlaybackViewModel.onPlayerReady') // 位於 82 個 frame 之後，只靠「App frame 一律保留」才會在
    expect(out).toContain('ArrayIndexOutOfBoundsException')
    expect(out).toContain('FATAL EXCEPTION')
    expect(out).toContain('[e2e-stage]')
    expect(out).toContain('TestRunner: started: whitelistVideoReachesReady')
    expect(out).not.toContain('THREAD_STATE')
    expect(out).toContain('略過全執行緒 dump 行=101')
    expect(out).toContain('…（重複 7 次）') // 連續重複 frame 摺疊
    expect(out).toContain('個 frame') // 非 App 的中間 frame 被省略並註明
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(CAP)
    expect(Buffer.byteLength(out)).toBeLessThan(20000) // 常態目標
    expect(out).toContain('App/test pid：') // 說明段
    expect(out).toMatch(/6529/)
  })

  it('例外以簽章去重並計次：同一份 log 讀兩遍，簽章 ×2、輸出不倍增', async () => {
    const once = (await extract('android', [FIXTURE])).stdout
    const twice = (await extract('android', [FIXTURE, FIXTURE])).stdout
    expect(twice).toMatch(/\[E\d+\] ×2 首次/)
    expect(twice).toContain('末次')
    expect(Buffer.byteLength(twice) - Buffer.byteLength(once)).toBeLessThan(2500)
    // 簽章數不變
    const sigs = (t: string) => (t.match(/^\[E\d+\]/gm) ?? []).length
    expect(sigs(twice)).toBe(sigs(once))
  })

  it('找不到 Start proc：退回「所有 E/F 行中含例外結構的區塊」，真因仍在', async () => {
    const stripped = fs
      .readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .filter((l) => !l.includes('Start proc'))
      .join('\n')
    const r = await extract('android', [write('nostart.txt', stripped)])
    expect(r.stdout).toContain('找不到 Start proc')
    expect(r.stdout).toContain('CalledFromWrongThreadException')
    expect(r.stdout).toContain('PlaybackViewModel.onPlayerReady')
    expect(r.stdout).toContain('ArrayIndexOutOfBoundsException')
    expect(r.stdout).not.toContain('THREAD_STATE')
  })

  it('E2E_SIGNALS_PACKAGE 覆寫套件名：不符的套件找不到 pid', async () => {
    const r = await extract('android', [FIXTURE], { E2E_SIGNALS_PACKAGE: 'com.other.app' })
    expect(r.stdout).toContain('找不到 Start proc')
    expect(r.stdout).toContain('App 套件：com.other.app')
  })

  it('硬上限：E2E_SIGNALS_MAX_BYTES 很小時仍不超量，且真因（含 App frame）優先留下', async () => {
    const r = await extract('android', [FIXTURE], { E2E_SIGNALS_MAX_BYTES: '4000' })
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(4000)
    expect(r.stdout).toContain('CalledFromWrongThreadException')
    expect(r.stdout).toContain('PlaybackViewModel.onPlayerReady')
    const tiny = await extract('android', [FIXTURE], { E2E_SIGNALS_MAX_BYTES: '2000' })
    expect(Buffer.byteLength(tiny.stdout)).toBeLessThanOrEqual(2000)
  })

  it('E2E_SIGNALS_MAX_FRAMES 控制每段 frame 數', async () => {
    const few = (await extract('android', [FIXTURE], { E2E_SIGNALS_MAX_FRAMES: '3' })).stdout
    const many = (await extract('android', [FIXTURE], { E2E_SIGNALS_MAX_FRAMES: '30' })).stdout
    expect(Buffer.byteLength(few)).toBeLessThan(Buffer.byteLength(many))
    expect(few).toContain('PlaybackViewModel.onPlayerReady') // 少 frame 也不丟 App frame
  })

  it('系統層事件：App 被殺／has died 與其他進程分開', async () => {
    const r = await extract('android', [FIXTURE])
    expect(r.stdout).toMatch(/系統層事件：與 App 相關/)
    expect(r.stdout).toMatch(/Process com\.trustnel\.app\.debug \(pid 6529\) has died/)
  })

  it('非 logcat 輸入（e2e.log）：只撈 [e2e 標記與 gradle 失敗行；非 UTF-8 不炸', async () => {
    const e2e = write(
      'e2e.log',
      Buffer.concat([
        Buffer.from('[e2e] 段落開始：playback\n> Task :phone:compile UP-TO-DATE\n'),
        Buffer.from([0xff, 0xfe, 0x0a]),
        Buffer.from('> Task :phone:connectedDebugAndroidTest FAILED\nBUILD FAILED in 1m\n[e2e] 段落失敗：playback（階段：播放）\n'),
      ]),
    )
    const r = await extract('android', [FIXTURE, e2e])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('[e2e] 段落失敗：playback（階段：播放）')
    expect(r.stdout).toContain('connectedDebugAndroidTest FAILED')
    expect(r.stdout).not.toContain('UP-TO-DATE')
  })

  it('用法錯誤 exit 2；讀不到任何輸入 exit 1', async () => {
    expect((await runBash(EXTRACT, [], {})).code).toBe(2)
    expect((await runBash(EXTRACT, ['windows', FIXTURE], {})).code).toBe(2)
    expect((await runBash(EXTRACT, ['android'], {})).code).toBe(2)
    const r = await extract('android', [path.join(dir, 'missing.log')])
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
  })

  it('ios：Test Case 起訖、error:、XCTAssert、崩潰與脈絡；重複錯誤去重；ANSI 去除', async () => {
    const lines = [
      '[e2e-stage] 進入：登入',
      "Test Case '-[UITests.PlaybackSmokeTests testEmbed]' started.",
      ...Array.from({ length: 30 }, (_, i) => `    t =   ${i}.00s Tap button ${i}`),
      '/work/EmbedTests.swift:88: \u001b[31merror\u001b[0m: -[UITests.PlaybackSmokeTests testEmbed] : XCTAssertTrue failed - ready 1',
      "Test Case '-[UITests.PlaybackSmokeTests testEmbed]' failed (31.000 seconds).",
      ...Array.from({ length: 30 }, (_, i) => `Compiling File${i}.swift`),
      '/work/EmbedTests.swift:88: error: -[UITests.PlaybackSmokeTests testEmbed] : XCTAssertTrue failed - ready 2',
      ...Array.from({ length: 30 }, (_, i) => `Compiling Other${i}.swift`),
      'Thread 0 Crashed:',
      '0   libswiftCore.dylib            0x00000001a5e1c9a4 _assertionFailure + 156',
      '1   Trustnel                      0x000000010293c5e8 PlaybackViewModel.onReady() + 88',
      "Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: 'x'",
      '** TEST FAILED **',
      'Executed 1 test, with 1 failure',
    ]
    const r = await extract('ios', [write('ios.log', lines.join('\n') + '\n')])
    expect(r.code).toBe(0)
    const out = r.stdout
    expect(out).toContain("Test Case '-[UITests.PlaybackSmokeTests testEmbed]' started.")
    expect(out).toContain('XCTAssertTrue failed')
    expect(out).toContain('Thread 0 Crashed')
    expect(out).toContain('PlaybackViewModel.onReady()')
    expect(out).toContain('Terminating app due to uncaught exception')
    expect(out).toContain('** TEST FAILED **')
    expect(out).toContain('[e2e-stage] 進入：登入')
    expect(out).toMatch(/×2/) // 兩次相同斷言（只差尾端數字）合併計次
    expect(out).not.toContain('\u001b')
    expect(out).not.toContain('Compiling File15.swift') // 遠離命中的雜訊不收
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(CAP)
  })

  const real = fs.existsSync(REAL_LOGCAT)
  it.skipIf(!real)('真實 2026-11-25 4MB logcat：關鍵行命中、≤ 上限、耗時合理', async () => {
    const t0 = Date.now()
    const r = await extract('android', [REAL_LOGCAT])
    const ms = Date.now() - t0
    expect(r.code).toBe(0)
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(CAP)
    for (const k of [
      'Error was captured in composition',
      'CalledFromWrongThreadException',
      'Calling: JavaBridge',
      'PlaybackViewModel.onPlayerReady',
      'ArrayIndexOutOfBoundsException',
      '[e2e-stage]',
    ])
      expect(r.stdout).toContain(k)
    expect(r.stdout).not.toContain('THREAD_STATE')
    expect(ms).toBeLessThan(20000)
    console.log(`real logcat: ${Buffer.byteLength(r.stdout)} bytes, ${ms} ms`)
  })
})

describe('diagnose-e2e-failure.sh × signals（DIAGNOSE_PRIORITY_FILES／DIAGNOSE_REDACTED_FULL_DIR）', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signals-diag-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const write = (name: string, content: string | Buffer) => {
    const p = path.join(dir, name)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    return p
  }
  const outFile = () => path.join(dir, 'out.txt')
  const dry = (files: string[], env: Record<string, string> = {}) =>
    runBash(DIAGNOSE, ['android', write('known.md', 'k'), outFile(), ...files], { DIAGNOSE_DRY_RUN: '1', ...env })

  const noise = (n: number, tag = 'I Noise') =>
    Array.from({ length: n }, (_, i) => `11-25 04:47:00.${String(i % 1000).padStart(3, '0')}  5903  5967 ${tag}: filler line number ${i} lorem ipsum dolor sit amet`).join('\n') + '\n'

  /** 依 Android workflow 的檔案組合重建 2026-11-25 的情境：真因在第 40KB 之後、被後面的 THREAD_STATE／雜訊大量淹沒 */
  const buildWorkflowFiles = async () => {
    const fixture = fs.readFileSync(FIXTURE, 'utf8')
    const padding = noise(900, 'E THREAD_STATE') // ≈ 100KB 的 thread dump
    const logcat = noise(500) + fixture + padding + noise(3000) // ≈ 0.6MB，真因落在中間
    const focus = noise(400) + fixture + padding // 聚焦檔：真因落在頭 30% 之後、尾 70% 之前
    const logcatPath = write('logcat.txt', logcat)
    const focusPath = write('logcat-focus.txt', focus)
    const e2e = write('e2e.log', '[e2e] 段落開始：playback\n' + 'gradle line\n'.repeat(2500) + '[e2e] 段落失敗：playback（階段：播放）\n')
    const junit = write(
      'TEST-test(AVD) - 14.xml',
      '<?xml version="1.0"?><testsuite name="x" tests="1" failures="1"><testcase name="whitelistVideoReachesReady"><failure message=""/></testcase></testsuite>\n',
    )
    const signals = write('signals.txt', (await runBash(EXTRACT, ['android', logcatPath, e2e], {})).stdout)
    return { logcatPath, focusPath, e2e, junit, signals }
  }

  it('(b) Android workflow 檔案組合：signals 優先整份送出 → log 必含 CalledFromWrongThread；沒有 signals 時真因被頭尾切掉', async () => {
    const f = await buildWorkflowFiles()
    const rest = [f.e2e, f.focusPath, f.junit, f.logcatPath]

    // 修正前的盲切情境：沒有 signals，真因落在被省略的中間
    const before = await dry(rest, { DIAGNOSE_MAX_BYTES: '200000' })
    expect(before.code).toBe(0)
    const beforeText = fs.readFileSync(outFile(), 'utf8')
    expect(beforeText).not.toContain('CalledFromWrongThread')
    expect(beforeText).toContain('頭 ') // 頭＋尾標題

    // 修正後：signals 第一個、列為優先檔
    const r = await dry([f.signals, ...rest], { DIAGNOSE_MAX_BYTES: '200000', DIAGNOSE_PRIORITY_FILES: f.signals })
    expect(r.code).toBe(0)
    const text = fs.readFileSync(outFile(), 'utf8')
    expect(text).toContain('CalledFromWrongThread')
    expect(text).toContain('PlaybackViewModel.onPlayerReady')
    expect(text).toContain('ArrayIndexOutOfBoundsException')
    expect(text).toMatch(/=== signals\.txt（完整，\d+ bytes）===【優先檔/)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200000)
    // 其餘檔照實標示頭＋尾
    expect(text).toMatch(/=== logcat\.txt（頭 \d+＋尾 \d+ \/ 共 \d+ bytes，中間省略 \d+ bytes）===/)
    expect(text).toMatch(/…（中間省略 \d+ bytes）…/)
    // signals 在最前面
    expect(text.indexOf('=== signals.txt')).toBeLessThan(text.indexOf('=== e2e.log'))
  })

  it('優先檔自己超過總預算：只在優先檔之間分（頭＋尾），其餘標示未收入；總量仍不超過上限', async () => {
    const big = write('big-signals.txt', 'HEAD_MARK\n' + noise(400) + 'TAIL_MARK\n')
    const other = write('other.log', 'OTHER_CONTENT\n')
    const r = await dry([big, other], { DIAGNOSE_MAX_BYTES: '6000', DIAGNOSE_PRIORITY_FILES: big })
    expect(r.code).toBe(0)
    const text = fs.readFileSync(outFile(), 'utf8')
    expect(text).toContain('HEAD_MARK')
    expect(text).toContain('TAIL_MARK')
    expect(text).toMatch(/=== big-signals\.txt（頭 \d+＋尾 \d+/)
    expect(text).toMatch(/=== other\.log（未收入：預算用盡/)
    expect(text).not.toContain('OTHER_CONTENT')
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(6000)
  })

  it('DIAGNOSE_PRIORITY_FILES 比對的是完整路徑字串；含 glob 字元的路徑也只做字面比對', async () => {
    const a = write('a[1].txt', 'AAA\n')
    const b = write('b.txt', 'BBB\n')
    await dry([a, b], { DIAGNOSE_PRIORITY_FILES: `${dir}/zzz:${a}` })
    const text = fs.readFileSync(outFile(), 'utf8')
    expect(text).toMatch(/=== a\[1\]\.txt（完整，\d+ bytes）===【優先檔/)
    expect(text).not.toMatch(/=== b\.txt（完整，\d+ bytes）===【優先檔/)
  })

  it('(c) DIAGNOSE_REDACTED_FULL_DIR：每個輸入檔遮蔽後的完整內容（未截斷），沿用 basename，同名加序號', async () => {
    const secret = 'S3CR3T-VALUE/x$y'
    const big = 'BIG_HEAD ' + `line with ${secret} inside\n`.repeat(8000) + 'BIG_TAIL\n' // ≈ 230KB，遠超預算
    const bigPath = write('x/big.log', big)
    const smallPath = write('y/small.log', `small ${secret}\n`)
    const dupPath = write('z/small.log', `dup ${secret}\n`)
    const bad = write('bad.log', Buffer.concat([Buffer.from('bad '), Buffer.from([0xff]), Buffer.from(` ${secret}\n`)]))
    const full = path.join(dir, 'full-out')
    const r = await dry([bigPath, smallPath, dupPath, bad], {
      DIAGNOSE_MAX_BYTES: '20000',
      E2E_SECRET: secret,
      DIAGNOSE_REDACT_VARS: 'E2E_SECRET',
      DIAGNOSE_REDACTED_FULL_DIR: full,
    })
    expect(r.code).toBe(0)
    expect(fs.readdirSync(full).sort()).toEqual(['bad.log', 'big.log', 'small.log', 'small.log.2'])
    const expectBig = big.split(secret).join('***')
    expect(fs.readFileSync(path.join(full, 'big.log'), 'utf8')).toBe(expectBig) // 完整、已遮蔽
    expect(fs.readFileSync(path.join(full, 'small.log'), 'utf8')).toBe('small ***\n')
    expect(fs.readFileSync(path.join(full, 'small.log.2'), 'utf8')).toBe('dup ***\n')
    expect(fs.readFileSync(path.join(full, 'bad.log'), 'utf8')).toBe('bad  ***\n') // 非 UTF-8 位元組已清
    for (const f of fs.readdirSync(full)) expect(fs.readFileSync(path.join(full, f), 'utf8')).not.toContain(secret)
    // 送給模型的那份仍受預算限制（被截斷），完整內容只在目錄裡
    const sent = fs.readFileSync(outFile(), 'utf8')
    expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(20000)
    expect(sent).not.toContain(secret)
  })

  it('DIAGNOSE_REDACTED_FULL_DIR 無法建立時只警告，診斷照常', async () => {
    const blocker = write('blocker', 'i am a file')
    const r = await dry([write('a.log', 'hello\n')], { DIAGNOSE_REDACTED_FULL_DIR: path.join(blocker, 'sub') })
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('cannot create DIAGNOSE_REDACTED_FULL_DIR')
    expect(fs.readFileSync(outFile(), 'utf8')).toContain('hello')
  })

  it('未設定新 env 時：不產生額外目錄、小檔仍完整', async () => {
    const r = await dry([write('a.log', 'hello\n')])
    expect(r.code).toBe(0)
    expect(fs.readFileSync(outFile(), 'utf8')).toMatch(/=== a\.log（完整，6 bytes）===\nhello\n/)
  })

  it('system prompt 含「signals 最可信」與「真因可能早於症狀」的提示', async () => {
    // 不經 dry-run：用假伺服器擷取 request
    const { startServer } = await import('./helpers')
    const server = await startServer(() => ({
      json: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ category: 'app', severity: 'P1', reason: 'r', suggestion: 's', needsCodeChange: true }) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }))
    try {
      const sig = write('signals.txt', 'SIGNALS\n')
      const r = await runBash(
        DIAGNOSE,
        ['android', write('known.md', 'k'), outFile(), sig, write('b.log', 'B\n')],
        { ANTHROPIC_BASE_URL: server.url, ANTHROPIC_API_KEY: 'sk-test', DIAGNOSE_PRIORITY_FILES: sig },
      )
      expect(r.code).toBe(0)
      const req = JSON.parse(server.requests.find((q) => q.path === '/v1/messages')!.body)
      expect(req.system).toContain('signals')
      expect(req.system).toContain('最可信')
      expect(req.system).toContain('比症狀早')
      expect(req.messages[0].content).toContain('【優先檔')
      expect(req.messages[0].content).toContain('最可信')
    } finally {
      await server.close()
    }
  })
})
