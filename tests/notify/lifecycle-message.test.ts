import { describe, it, expect } from 'vitest'
import { buildDiscordMessage } from '@/notify/message'
import {
  withAlertButtons,
  applyAcknowledged,
  applyResolved,
  applyIgnored,
  applyReopened,
  applyCount,
  buildResolveReply,
  buildFollowUpAlert,
  renderRoot,
  renderPreviousIncidentRoot,
} from '@/notify/lifecycle-message'

const uuid = '123e4567-e89b-42d3-a456-426614174000'
const base = {
  serviceName: 'svc',
  severity: 'P0' as const,
  errorType: 'TypeError',
  message: 'boom',
  count: 7,
  firstSeen: 'f',
  lastSeen: 'l',
  ownerDiscordId: '999',
}
const withBtn = () =>
  withAlertButtons(buildDiscordMessage(base), uuid, 1, ['ack', 'resolve'])
const ids = (m: ReturnType<typeof withBtn>) =>
  (m.components ?? []).flatMap((r) => r.components.map((c) => c.custom_id))

describe('withAlertButtons', () => {
  it('依 actions 產生按鈕且不改輸入', () => {
    const src = buildDiscordMessage(base)
    const snap = structuredClone(src)
    const m = withAlertButtons(src, uuid, 1, ['ack', 'resolve'])
    expect(src).toEqual(snap)
    expect(m.components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: '✋ 確認', custom_id: `ack:${uuid}:1` },
          { type: 2, style: 3, label: '✅ 已解決', custom_id: `resolve:${uuid}:1` },
        ],
      },
    ])
  })
})

describe('applyAcknowledged', () => {
  it('加欄位、只留 resolve 按鈕、去 content', () => {
    const src = withBtn()
    const snap = structuredClone(src)
    const m = applyAcknowledged(src, 'discord:111', '2026-11-10T00:00:00.000Z', uuid, 1)
    expect(src).toEqual(snap)
    expect(m.content).toBeUndefined()
    expect(m.allowed_mentions).toEqual({ parse: [] })
    expect(ids(m)).toEqual([`resolve:${uuid}:1`])
    expect(m.embeds[0].fields).toContainEqual({
      name: '✋ 已確認',
      value: '<@111>（08:00）',
      inline: false,
    })
  })
  it('email 原樣顯示', () => {
    const m = applyAcknowledged(withBtn(), 'a@b.c', 'T', uuid, 1)
    expect(m.embeds[0].fields.find((f) => f.name === '✋ 已確認')?.value).toBe('a@b.c（T）')
  })
})

describe('applyResolved', () => {
  it('poll 自動恢復', () => {
    const m = applyResolved(withBtn(), { actorLabel: null, source: 'poll' })
    expect(m.embeds[0].color).toBe(0x2ecc71)
    expect(m.embeds[0].title.startsWith('✅ 已解決 ')).toBe(true)
    expect(m.embeds[0].fields.find((f) => f.name === '處理方式')?.value).toBe('自動恢復（輪詢）')
    expect(m.components).toBeUndefined()
    expect(m.content).toBeUndefined()
    expect(m.allowed_mentions).toEqual({ parse: [] })
  })
  it('heartbeat／manual', () => {
    expect(
      applyResolved(withBtn(), { actorLabel: 'x@y.z', source: 'heartbeat' }).embeds[0].fields.find(
        (f) => f.name === '處理方式',
      )?.value,
    ).toBe('自動恢復（心跳）')
    expect(
      applyResolved(withBtn(), { actorLabel: 'discord:5', source: 'manual' }).embeds[0].fields.find(
        (f) => f.name === '處理方式',
      )?.value,
    ).toBe('手動：<@5>')
    expect(
      applyResolved(withBtn(), { actorLabel: 'a@b.c', source: 'manual' }).embeds[0].fields.find(
        (f) => f.name === '處理方式',
      )?.value,
    ).toBe('手動：a@b.c')
  })
  it('重複套用不疊加前綴與欄位', () => {
    const once = applyResolved(withBtn(), { actorLabel: null, source: 'poll' })
    const twice = applyResolved(once, { actorLabel: null, source: 'poll' })
    expect(twice.embeds[0].title).toBe('✅ 已解決 [P0] svc — TypeError')
    expect(twice.embeds[0].fields.filter((f) => f.name === '處理方式')).toHaveLength(1)
  })
})

describe('applyIgnored', () => {
  it('灰色、前綴、移除按鈕', () => {
    const m = applyIgnored(applyIgnored(withBtn()))
    expect(m.embeds[0].color).toBe(0x95a5a6)
    expect(m.embeds[0].title).toBe('🚫 已忽略 [P0] svc — TypeError')
    expect(m.components).toBeUndefined()
    expect(m.content).toBeUndefined()
  })
})

describe('applyReopened', () => {
  it('只留一個復發欄位並取最新次數', () => {
    const m = applyReopened(applyReopened(withBtn(), 2), 3)
    const fs = m.embeds[0].fields.filter((f) => f.name === '🔁 已復發')
    expect(fs).toHaveLength(1)
    expect(fs[0].value).toBe('第 3 次 → 見最新回覆')
    expect(m.components).toBeUndefined()
    expect(m.content).toBeUndefined()
  })
})

describe('applyCount', () => {
  it('只改次數與 Last seen', () => {
    const src = withBtn()
    const m = applyCount(src, 42, 'L2')
    const get = (mm: typeof m, n: string) => mm.embeds[0].fields.find((f) => f.name === n)?.value
    expect(get(m, '次數')).toBe('42')
    expect(get(m, 'Last seen')).toBe('L2')
    expect(get(m, 'First seen')).toBe('f')
    expect(m.components).toEqual(src.components)
    expect(m.content).toBe(src.content)
  })
})

describe('reply builders', () => {
  it('buildResolveReply', () => {
    const m = buildResolveReply('heartbeat', 'm1')
    expect(m.content).toBe('✅ 已自動恢復')
    expect(m.allowed_mentions).toEqual({ parse: [] })
    expect(m.message_reference).toEqual({ message_id: 'm1', fail_if_not_exists: false })
    expect(buildResolveReply('manual', 'm1').content).toBe('✅ 已解決')
  })
  it('buildFollowUpAlert 保留 tag、移除 components', () => {
    const alert = withBtn()
    const m = buildFollowUpAlert(alert, 'm9')
    expect(m.content).toBe('<@999>')
    expect(m.allowed_mentions).toEqual({ parse: [], users: ['999'] })
    expect(m.message_reference?.message_id).toBe('m9')
    expect(m.components).toBeUndefined()
  })
})

describe('renderRoot', () => {
  const issue = {
    id: uuid,
    status: 'open' as const,
    count: 12,
    lastSeen: 'L2',
    acknowledgedBy: null as string | null,
    acknowledgedAt: null as string | null,
    resolvedBy: null as string | null,
    reopenCount: 1,
  }
  const names = (m: ReturnType<typeof withBtn>) => m.embeds[0].fields.map((f) => f.name)
  const val = (m: ReturnType<typeof withBtn>, n: string) => m.embeds[0].fields.find((f) => f.name === n)?.value

  it('open：帶最新次數、移除 content 與 mention、兩顆按鈕', () => {
    const m = renderRoot(withBtn(), issue)
    expect(val(m, '次數')).toBe('12')
    expect(val(m, 'Last seen')).toBe('L2')
    expect(m.content).toBeUndefined()
    expect(m.allowed_mentions).toEqual({ parse: [] })
    expect(ids(m)).toEqual([`ack:${uuid}:1`, `resolve:${uuid}:1`])
  })

  it('open 且已確認：只留 resolve 按鈕', () => {
    const m = renderRoot(withBtn(), { ...issue, acknowledgedBy: 'discord:1', acknowledgedAt: 'T' })
    expect(ids(m)).toEqual([`resolve:${uuid}:1`])
    expect(names(m)).toContain('✋ 已確認')
  })

  it('resolved（曾確認）：綠色、保留已確認欄位、最新次數、無按鈕', () => {
    const m = renderRoot(
      withBtn(),
      { ...issue, status: 'resolved', acknowledgedBy: 'discord:1', acknowledgedAt: 'T', resolvedBy: 'a@b.c' },
      'manual',
    )
    expect(m.embeds[0].color).toBe(0x2ecc71)
    expect(names(m)).toContain('✋ 已確認')
    expect(val(m, '次數')).toBe('12')
    expect(val(m, '處理方式')).toContain('a@b.c')
    expect(m.components).toBeUndefined()
    expect(m.content).toBeUndefined()
  })

  it('acknowledged：已確認欄位、僅 resolve 按鈕', () => {
    const m = renderRoot(withBtn(), { ...issue, status: 'acknowledged', acknowledgedBy: 'discord:1', acknowledgedAt: 'T' })
    expect(names(m)).toContain('✋ 已確認')
    expect(ids(m)).toEqual([`resolve:${uuid}:1`])
  })

  it('ignored：灰色、無按鈕', () => {
    const m = renderRoot(withBtn(), { ...issue, status: 'ignored' })
    expect(m.embeds[0].color).toBe(0x95a5a6)
    expect(m.components).toBeUndefined()
  })

  it('不改輸入', () => {
    const src = withBtn()
    const snap = structuredClone(src)
    renderRoot(src, issue)
    expect(src).toEqual(snap)
  })
})

describe('renderPreviousIncidentRoot', () => {
  it('綠色、已解決前綴、無按鈕與 content、帶已復發欄位、無處理方式', () => {
    const m = renderPreviousIncidentRoot(withBtn(), 2)
    expect(m.embeds[0].color).toBe(0x2ecc71)
    expect(m.embeds[0].title.startsWith('✅ 已解決 ')).toBe(true)
    expect(m.components).toBeUndefined()
    expect(m.content).toBeUndefined()
    expect(m.allowed_mentions).toEqual({ parse: [] })
    const f = m.embeds[0].fields
    expect(f.find((x) => x.name === '🔁 已復發')?.value).toBe('第 2 次 → 見最新回覆')
    expect(f.some((x) => x.name === '處理方式')).toBe(false)
  })
})
