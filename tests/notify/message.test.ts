import { describe, it, expect } from 'vitest'
import { buildDiscordMessage } from '@/notify/message'

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
