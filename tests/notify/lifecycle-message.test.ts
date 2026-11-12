import { describe, it, expect } from 'vitest'
import { buildDiscordMessage } from '@/notify/message'
import {
  withAlertButtons,
  withoutButtons,
  buildAckReply,
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
          { type: 2, style: 2, label: 'Acknowledge', custom_id: `ack:${uuid}:1` },
          { type: 2, style: 3, label: 'Resolve', custom_id: `resolve:${uuid}:1` },
        ],
      },
    ])
  })
})

describe('withoutButtons', () => {
  it('只移除按鈕，embed 與顏色完全不動', () => {
    const src = withBtn()
    const snap = structuredClone(src)
    const m = withoutButtons(src)
    expect(src).toEqual(snap)
    expect(m.components).toBeUndefined()
    expect(m.content).toBeUndefined()
    expect(m.allowed_mentions).toEqual({ parse: [] })
    expect(m.embeds).toEqual(src.embeds)
  })
})

describe('applyIgnored', () => {
  it('灰色、前綴、移除按鈕', () => {
    const m = applyIgnored(applyIgnored(withBtn()))
    expect(m.embeds[0].color).toBe(0x95a5a6)
    expect(m.embeds[0].title).toBe('⚪ Ignored [P0] svc — TypeError')
    expect(m.components).toBeUndefined()
    expect(m.content).toBeUndefined()
  })
})

describe('applyReopened', () => {
  it('只留一個復發欄位並取最新次數', () => {
    const m = applyReopened(applyReopened(withBtn(), 2), 3)
    const fs = m.embeds[0].fields.filter((f) => f.name === '↻ Reopened')
    expect(fs).toHaveLength(1)
    expect(fs[0].value).toBe('第 3 次，見最新回覆')
    expect(m.components).toBeUndefined()
    expect(m.content).toBeUndefined()
  })
})

describe('applyCount', () => {
  it('舊根訊息使用 Last seen 欄位名時仍會更新時間', () => {
    const old = structuredClone(withBtn())
    for (const f of old.embeds[0].fields) {
      if (f.name === '最近') f.name = 'Last seen'
    }
    const m = applyCount(old, 5, 'L9')
    const get = (n: string) => m.embeds[0].fields.find((f) => f.name === n)?.value
    expect(get('Last seen')).toBe('L9')
    expect(get('次數')).toBe('5')
  })


  it('只改次數與最近', () => {
    const src = withBtn()
    const m = applyCount(src, 42, 'L2')
    const get = (mm: typeof m, n: string) => mm.embeds[0].fields.find((f) => f.name === n)?.value
    expect(get(m, '次數')).toBe('42')
    expect(get(m, '最近')).toBe('L2')
    expect(get(m, '首次')).toBe('f')
    expect(m.components).toEqual(src.components)
    expect(m.content).toBe(src.content)
  })
})

describe('reply builders', () => {
  it('buildResolveReply：自動恢復分別顯示輪詢與心跳', () => {
    expect(buildResolveReply('poll', 'm1').content).toBe('🟢 Resolved — 自動恢復（輪詢）')
    expect(buildResolveReply('heartbeat', 'm1').content).toBe('🟢 Resolved — 自動恢復（心跳）')
  })

  it('buildResolveReply：自動恢復固定文字、手動帶人名與時間、不 tag', () => {
    const m = buildResolveReply('heartbeat', 'm1')
    expect(m.content).toBe('🟢 Resolved — 自動恢復（心跳）')
    expect(m.allowed_mentions).toEqual({ parse: [] })
    expect(m.message_reference).toEqual({ message_id: 'm1', fail_if_not_exists: false })
    expect(buildResolveReply('poll', 'm1', { actorLabel: 'discord:5', atIso: 'T' }).content).toBe('🟢 Resolved — 自動恢復（輪詢）')
    expect(buildResolveReply('manual', 'm1').content).toBe('🟢 Resolved')
    const d = buildResolveReply('manual', 'm1', { actorLabel: 'discord:5', atIso: '2026-11-10T00:00:00.000Z' })
    expect(d.content).toBe('🟢 Resolved — <@5> · 08:00')
    expect(d.allowed_mentions).toEqual({ parse: [] })
    expect(d.message_reference).toEqual({ message_id: 'm1', fail_if_not_exists: false })
    expect(buildResolveReply('manual', 'm1', { actorLabel: 'a@b.c', atIso: 'T' }).content).toBe('🟢 Resolved — a@b.c · T')
  })
  it('buildAckReply：Discord 用 mention 文字、dashboard 顯示 email，皆不 tag、指向根訊息', () => {
    const d = buildAckReply('discord:111', '2026-11-10T00:00:00.000Z', 'm1')
    expect(d.content).toBe('🟡 Acknowledged — <@111> · 08:00')
    expect(d.allowed_mentions).toEqual({ parse: [] })
    expect(d.message_reference).toEqual({ message_id: 'm1', fail_if_not_exists: false })
    expect(buildAckReply('a@b.c', 'T', 'm1').content).toBe('🟡 Acknowledged — a@b.c · T')
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
    expect(val(m, '最近')).toBe('L2')
    expect(m.content).toBeUndefined()
    expect(m.allowed_mentions).toEqual({ parse: [] })
    expect(ids(m)).toEqual([`ack:${uuid}:1`, `resolve:${uuid}:1`])
  })

  it('open 且已確認：只留 resolve 按鈕，內容不加欄位', () => {
    const m = renderRoot(withBtn(), { ...issue, acknowledgedBy: 'discord:1', acknowledgedAt: 'T' })
    expect(ids(m)).toEqual([`resolve:${uuid}:1`])
    expect(names(m)).not.toContain('✋ 已確認')
  })

  it('resolved（曾確認）：embed 顏色／標題／欄位與原文相同（除次數），無按鈕', () => {
    const src = withBtn()
    const m = renderRoot(src, {
      ...issue,
      status: 'resolved',
      acknowledgedBy: 'discord:1',
      acknowledgedAt: 'T',
    })
    expect(m.embeds[0].color).toBe(src.embeds[0].color)
    expect(m.embeds[0].title).toBe(src.embeds[0].title)
    expect(names(m)).toEqual(names(src))
    expect(val(m, '次數')).toBe('12')
    expect(m.components).toBeUndefined()
    expect(m.content).toBeUndefined()
  })

  it('acknowledged：embed 與原文相同（除次數／Last seen）、僅 resolve 按鈕', () => {
    const src = withBtn()
    const m = renderRoot(src, { ...issue, status: 'acknowledged', acknowledgedBy: 'discord:1', acknowledgedAt: 'T' })
    expect(names(m)).toEqual(names(src))
    expect(m.embeds[0].color).toBe(src.embeds[0].color)
    expect(m.embeds[0].title).toBe(src.embeds[0].title)
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
    expect(m.embeds[0].title.startsWith('🟢 Resolved ')).toBe(true)
    expect(m.embeds[0].title).not.toMatch(/🔴|🟠|🔵/u)
    expect(m.components).toBeUndefined()
    expect(m.content).toBeUndefined()
    expect(m.allowed_mentions).toEqual({ parse: [] })
    const f = m.embeds[0].fields
    expect(f.find((x) => x.name === '↻ Reopened')?.value).toBe('第 2 次，見最新回覆')
    expect(f.some((x) => x.name === '處理方式')).toBe(false)
  })
})
