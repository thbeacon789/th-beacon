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
