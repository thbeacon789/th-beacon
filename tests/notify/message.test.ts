import { describe, it, expect } from 'vitest'
import { buildDiscordMessage, extractNotifyDetails } from '@/notify/message'

const base = {
  serviceName: 'svc-a',
  severity: 'P0' as const,
  errorType: 'DBError',
  message: 'db down: connection refused',
  count: 7,
  firstSeen: '2026-07-28T10:00:00.000Z',
  lastSeen: '2026-07-28T10:25:00.000Z',
}

describe('buildDiscordMessage', () => {
  it('builds an embed with title, color, fields', () => {
    const msg = buildDiscordMessage(base)
    expect(msg.username).toBe('th-beacon')
    expect(msg.embeds).toHaveLength(1)
    expect(msg.embeds[0].title).toBe('[P0] svc-a — DBError')
    expect(msg.embeds[0].color).toBe(0xe74c3c)
    expect(msg.embeds[0].description).toBe('db down: connection refused')
    expect(msg.embeds[0].url).toBeUndefined()
    expect(msg.embeds[0].fields).toEqual([
      { name: '次數', value: '7', inline: true },
      { name: 'First seen', value: '2026-07-28T10:00:00.000Z', inline: true },
      { name: 'Last seen', value: '2026-07-28T10:25:00.000Z', inline: true },
    ])
  })

  it('uses severity colors and attaches dashboard url when provided', () => {
    expect(buildDiscordMessage({ ...base, severity: 'P1' }).embeds[0].color).toBe(0xe67e22)
    expect(buildDiscordMessage({ ...base, severity: 'P2' }).embeds[0].color).toBe(0x95a5a6)
    expect(
      buildDiscordMessage({ ...base, dashboardUrl: 'https://beacon.example.com' }).embeds[0].url,
    ).toBe('https://beacon.example.com')
  })

  it('truncates description at 500 chars', () => {
    const long = 'x'.repeat(600)
    const description = buildDiscordMessage({ ...base, message: long }).embeds[0].description
    expect(description).toHaveLength(500)
    expect(description.endsWith('…')).toBe(true)
  })
})

describe('extractNotifyDetails', () => {
  it('只取白名單鍵，忽略其他', () => {
    const details = extractNotifyDetails({
      summary: '3 of 210 failed',
      reason: 'timeout',
      lastRunAt: '2026-07-28T03:00:00.000Z',
      heartbeat: 'daily-test',
      secretToken: 'should-not-appear',
    })
    expect(details).toEqual({
      summary: '3 of 210 failed',
      reason: 'timeout',
      lastRunAt: '2026-07-28T03:00:00.000Z',
    })
  })

  it('忽略非字串值與空字串', () => {
    expect(extractNotifyDetails({ summary: 42, reason: null, lastRunAt: '' })).toEqual({})
  })

  it('丟棄非 http(s) 的 runUrl', () => {
    expect(extractNotifyDetails({ runUrl: 'javascript:alert(1)' })).toEqual({})
    expect(extractNotifyDetails({ runUrl: 'https://ci/run/1' })).toEqual({
      runUrl: 'https://ci/run/1',
    })
  })

  it('丟棄含 ) 的 runUrl（markdown 連結注入 payload）', () => {
    const details = extractNotifyDetails({
      runUrl: 'https://ci.example.com/1) [🔥點我看詳情](https://evil.example.com/phish',
    })
    expect(details).not.toHaveProperty('runUrl')
  })

  it('丟棄含空白或換行的 runUrl', () => {
    expect(extractNotifyDetails({ runUrl: 'https://ci.example.com/run 1' })).not.toHaveProperty(
      'runUrl',
    )
    expect(
      extractNotifyDetails({ runUrl: 'https://ci.example.com/run\n1' }),
    ).not.toHaveProperty('runUrl')
  })

  it('放行正常的 GitHub Actions run URL', () => {
    expect(
      extractNotifyDetails({
        runUrl: 'https://github.com/org/repo/actions/runs/1234567890',
      }),
    ).toEqual({ runUrl: 'https://github.com/org/repo/actions/runs/1234567890' })
  })

  it('放行帶 query string 的 URL', () => {
    expect(
      extractNotifyDetails({ runUrl: 'https://ci.example.com/run?id=42&x=1' }),
    ).toEqual({ runUrl: 'https://ci.example.com/run?id=42&x=1' })
  })

  it('scheme 驗證的對抗性測資', () => {
    expect(extractNotifyDetails({ runUrl: ' https://x' })).not.toHaveProperty('runUrl')
    expect(extractNotifyDetails({ runUrl: 'https:/evil' })).not.toHaveProperty('runUrl')
    expect(extractNotifyDetails({ runUrl: 'HTTPS://ci.example.com/1' })).toEqual({
      runUrl: 'HTTPS://ci.example.com/1',
    })
  })

  it('過長的值截斷至 1000 字元並補省略號', () => {
    const details = extractNotifyDetails({ summary: 'x'.repeat(2000) })
    expect(details.summary).toHaveLength(1000)
    expect(details.summary?.endsWith('…')).toBe(true)
  })
})

describe('buildDiscordMessage details', () => {
  const base = {
    serviceName: 'svc-a',
    severity: 'P1' as const,
    errorType: 'test_failure',
    message: 'Test failed: daily-test',
    count: 3,
    firstSeen: '2026-07-28T03:00:00.000Z',
    lastSeen: '2026-07-29T03:00:00.000Z',
  }

  it('無 details 時欄位與既有行為一致', () => {
    const msg = buildDiscordMessage(base)
    expect(msg.embeds[0].fields.map((f) => f.name)).toEqual(['次數', 'First seen', 'Last seen'])
  })

  it('summary 與 runUrl 附加成欄位，runUrl 為 markdown 連結', () => {
    const msg = buildDiscordMessage({
      ...base,
      details: { summary: '3 of 210 failed', runUrl: 'https://ci/run/1' },
    })
    const fields = msg.embeds[0].fields
    expect(fields.find((f) => f.name === '失敗摘要')?.value).toBe('3 of 210 failed')
    expect(fields.find((f) => f.name === 'CI Run')?.value).toBe('[查看 run](https://ci/run/1)')
  })

  it('欄位總數不超過 Discord 的 25 個上限', () => {
    const msg = buildDiscordMessage({
      ...base,
      details: {
        summary: 's',
        runUrl: 'https://ci/run/1',
        reason: 'r',
        lastRunAt: '2026-07-28T03:00:00.000Z',
      },
    })
    expect(msg.embeds[0].fields.length).toBeLessThanOrEqual(25)
  })
})

describe('extractNotifyDetails diagnosis', () => {
  it('extractNotifyDetails 取出 diagnosis', () => {
    expect(
      extractNotifyDetails({
        diagnosis: { category: 'env', severity: 'P2', reason: 'R', suggestion: 'S' },
      }),
    ).toEqual({ category: 'env', diagnosisReason: 'R', suggestion: 'S' })
  })

  it('diagnosis 結構不合法時不取', () => {
    expect(
      extractNotifyDetails({ diagnosis: { category: 'bogus', reason: 'R', suggestion: 'S' } }),
    ).not.toHaveProperty('category')
    expect(extractNotifyDetails({ diagnosis: 'nope' })).toEqual({})
    expect(extractNotifyDetails({ diagnosis: ['env'] })).toEqual({})
    expect(extractNotifyDetails({ diagnosis: { category: 'app', reason: 5, suggestion: '' } })).toEqual({
      category: 'app',
    })
  })

  it('diagnosis 字串套用截斷', () => {
    const d = extractNotifyDetails({
      diagnosis: { category: 'app', reason: 'x'.repeat(2000), suggestion: 'S' },
    })
    expect(d.diagnosisReason?.length).toBe(1000)
  })

  it('extractNotifyDetails 取出 diagnosisError', () => {
    expect(extractNotifyDetails({ diagnosisError: 'timeout' })).toEqual({ diagnosisError: 'timeout' })
  })
})

describe('buildDiscordMessage diagnosis', () => {
  const b = {
    serviceName: 'svc',
    errorType: 'test_failure',
    message: 'm',
    count: 1,
    firstSeen: 'a',
    lastSeen: 'b',
  }

  it('有分類時標題為中文判定', () => {
    expect(
      buildDiscordMessage({ ...b, severity: 'P2', details: { category: 'env' } }).embeds[0].title,
    ).toBe('[P2] svc — 環境問題')
    expect(
      buildDiscordMessage({ ...b, severity: 'P1', details: { category: 'app' } }).embeds[0].title,
    ).toBe('[P1] svc — app 問題')
    expect(buildDiscordMessage({ ...b, severity: 'P1' }).embeds[0].title).toBe('[P1] svc — test_failure')
  })

  it('自由文字欄位中的 markdown 連結被拆開', () => {
    const evil = '點[這裡](https://evil.example)'
    const msg = buildDiscordMessage({
      ...b,
      severity: 'P1',
      details: { diagnosisReason: evil, suggestion: evil, diagnosisError: evil },
    })
    const vals = msg.embeds[0].fields.filter((f) => ['判定原因', '修正建議', 'AI 判讀失敗'].includes(f.name))
    expect(vals).toHaveLength(3)
    for (const f of vals) expect(f.value).not.toContain('](')
  })

  it('中和連結後仍不超過欄位上限', () => {
    const suggestion = ']('.repeat(30) + 'x'.repeat(930)
    expect(suggestion.length).toBe(990)
    const details = extractNotifyDetails({ diagnosis: { category: 'app', reason: 'R', suggestion } })
    const msg = buildDiscordMessage({ ...b, severity: 'P1', details })
    const f = msg.embeds[0].fields.find((x) => x.name === '修正建議')
    expect(f?.value.length).toBeLessThanOrEqual(1000)
    expect(f?.value).not.toContain('](')
  })

  it('欄位順序與標籤', () => {
    const msg = buildDiscordMessage({
      ...b,
      severity: 'P1',
      details: {
        summary: 'sum',
        diagnosisReason: 'why',
        suggestion: 'fix',
        diagnosisError: 'err',
        runUrl: 'https://ci/run/1',
      },
    })
    expect(msg.embeds[0].fields.map((f) => f.name)).toEqual([
      '次數',
      'First seen',
      'Last seen',
      '失敗摘要',
      '判定原因',
      '修正建議',
      'AI 判讀失敗',
      'CI Run',
    ])
  })
})
