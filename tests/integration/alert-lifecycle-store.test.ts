import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createServiceRoleClient, cleanDatabase } from './helpers'
import { SupabaseStore } from '@/store/supabase'
import type { NotificationRecord } from '@/store/contracts'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import type { CanonicalEvent } from '@/core/types'
import type { DiscordMessage } from '@/notify/message'

let client: SupabaseClient<Database>
let store: SupabaseStore
let serviceId: string

const event = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  serviceId,
  source: 'push',
  level: 'error',
  errorType: 'TypeError',
  message: 'boom',
  fingerprint: 'fp-1',
  occurredAt: '2026-11-10T10:00:00.000Z',
  metadata: {},
  ...over,
})

const payload = (title: string): DiscordMessage =>
  ({ username: 'beacon', allowed_mentions: { parse: [] }, embeds: [{ title }] }) as unknown as DiscordMessage

async function notify(issueId: string, over: Partial<NotificationRecord> = {}): Promise<void> {
  await store.recordNotification({
    issueId,
    serviceId,
    fingerprint: 'fp-1',
    severity: 'P1',
    status: 'sent',
    countAtSend: 1,
    sentAt: '2026-11-10T10:00:00.000Z',
    kind: 'alert',
    incidentSeq: 0,
    discordChannelId: 'ch-1',
    discordMessageId: 'msg-1',
    payload: payload('root'),
    ...over,
  })
}

beforeAll(() => {
  client = createServiceRoleClient()
  store = new SupabaseStore(client)
})

beforeEach(async () => {
  await cleanDatabase(client)
  const { data, error } = await client.from('services').insert({ name: 'svc-lc' }).select('id').single()
  if (error) throw error
  serviceId = data.id
})

describe('SupabaseStore.getIncidentRoot', () => {
  it('回傳該 seq 最早一筆 sent 的 alert（含 channel／message／payload）', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    await notify(issue.id, { sentAt: '2026-11-10T10:05:00.000Z', discordMessageId: 'late', payload: payload('late') })
    await notify(issue.id, { sentAt: '2026-11-10T10:01:00.000Z', discordMessageId: 'early', payload: payload('early') })
    const root = await store.getIncidentRoot(issue.id, 0)
    expect(root).toMatchObject({ channelId: 'ch-1', messageId: 'early' })
    expect((root!.payload.embeds[0] as { title: string }).title).toBe('early')
  })

  it('略過 failed、非 alert 與無 message id 的通知；不同 seq 互不干擾；皆無回 null', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    await notify(issue.id, { status: 'failed', discordMessageId: 'f', sentAt: '2026-11-10T09:00:00.000Z' })
    await notify(issue.id, { kind: 'count_edit', discordMessageId: 'c', sentAt: '2026-11-10T09:01:00.000Z' })
    await notify(issue.id, { kind: 'resolve_reply', discordMessageId: 'r', sentAt: '2026-11-10T09:02:00.000Z' })
    await notify(issue.id, { discordMessageId: null, sentAt: '2026-11-10T09:03:00.000Z' })
    expect(await store.getIncidentRoot(issue.id, 0)).toBeNull()

    await notify(issue.id, { incidentSeq: 1, discordMessageId: 'seq1', sentAt: '2026-11-10T11:00:00.000Z' })
    await notify(issue.id, { incidentSeq: 0, discordMessageId: 'seq0', sentAt: '2026-11-10T12:00:00.000Z' })
    expect((await store.getIncidentRoot(issue.id, 1))?.messageId).toBe('seq1')
    expect((await store.getIncidentRoot(issue.id, 0))?.messageId).toBe('seq0')
    expect(await store.getIncidentRoot(issue.id, 2)).toBeNull()
  })
})

describe('SupabaseStore.getLatestSentNotification', () => {
  it('只看同 incident_seq；alert 與 count_edit 計入、resolve_reply 與 failed 不計入', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    expect(await store.getLatestSentNotification(serviceId, 'fp-1', 0)).toBeNull()

    await notify(issue.id, { sentAt: '2026-11-10T10:00:00.000Z', severity: 'P2' })
    await notify(issue.id, { kind: 'count_edit', sentAt: '2026-11-10T10:10:00.000Z', severity: 'P1' })
    await notify(issue.id, { kind: 'resolve_reply', sentAt: '2026-11-10T10:20:00.000Z', severity: 'P0' })
    await notify(issue.id, { status: 'failed', sentAt: '2026-11-10T10:30:00.000Z', severity: 'P0' })
    await notify(issue.id, { incidentSeq: 1, sentAt: '2026-11-10T10:40:00.000Z', severity: 'P0' })

    const seq0 = await store.getLatestSentNotification(serviceId, 'fp-1', 0)
    expect(seq0?.severity).toBe('P1')
    expect(new Date(seq0!.sentAt).toISOString()).toBe('2026-11-10T10:10:00.000Z')

    const seq1 = await store.getLatestSentNotification(serviceId, 'fp-1', 1)
    expect(seq1?.severity).toBe('P0')
    expect(await store.getLatestSentNotification(serviceId, 'fp-1', 2)).toBeNull()
    expect(await store.getLatestSentNotification(serviceId, 'other', 0)).toBeNull()
  })
})

describe('SupabaseStore.transitionIssueStatus', () => {
  const NOW = '2026-11-10T12:00:00.000Z'

  it('寫入 acknowledged／resolved 的 at／by；open 清空', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    const ack = await store.transitionIssueStatus(issue.id, 'acknowledged', ['open'], 'alice', NOW)
    expect(ack?.changed).toBe(true)
    expect(ack?.issue).toMatchObject({ status: 'acknowledged', acknowledgedBy: 'alice' })
    expect(new Date(ack!.issue.acknowledgedAt!).toISOString()).toBe(NOW)

    const res = await store.transitionIssueStatus(issue.id, 'resolved', ['open', 'acknowledged'], 'bob', NOW)
    expect(res?.issue).toMatchObject({ status: 'resolved', resolvedBy: 'bob' })
    expect(new Date(res!.issue.resolvedAt!).toISOString()).toBe(NOW)
    expect(res!.issue.acknowledgedBy).toBe('alice')

    const reopened = await store.transitionIssueStatus(issue.id, 'open', ['resolved'], null, NOW)
    expect(reopened?.issue).toMatchObject({
      status: 'open',
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
    })
  })

  it('現況不在 allowedFrom：changed=false 且回現況；不存在回 null', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    const r = await store.transitionIssueStatus(issue.id, 'resolved', ['acknowledged'], 'bob', NOW)
    expect(r?.changed).toBe(false)
    expect(r?.issue.status).toBe('open')
    expect(r?.issue.resolvedAt).toBeNull()
    expect(
      await store.transitionIssueStatus('00000000-0000-0000-0000-000000000000', 'resolved', ['open'], null, NOW),
    ).toBeNull()
  })

  it('expectedReopenCount 不符不更新（changed=false 回現況），相符才更新', async () => {
    const { issue } = await store.upsertIssueWithEvent(event())
    await store.transitionIssueStatus(issue.id, 'resolved', ['open'], 'bob', NOW)
    await store.upsertIssueWithEvent(event({ occurredAt: '2026-11-10T13:00:00.000Z' })) // reopen_count = 1

    const stale = await store.transitionIssueStatus(issue.id, 'acknowledged', ['open'], 'alice', NOW, 0)
    expect(stale?.changed).toBe(false)
    expect(stale?.issue).toMatchObject({ status: 'open', reopenCount: 1, acknowledgedAt: null, acknowledgedBy: null })

    const ok = await store.transitionIssueStatus(issue.id, 'acknowledged', ['open'], 'alice', NOW, 1)
    expect(ok?.changed).toBe(true)
    expect(ok?.issue).toMatchObject({ status: 'acknowledged', acknowledgedBy: 'alice' })
  })
})

describe('rpc upsert_issue_with_event 復發語意', () => {
  it('resolved 後再 upsert：回 open、reopen+1、事故計數與起點重置、確認／解決紀錄清空', async () => {
    const first = await store.upsertIssueWithEvent(event())
    await store.upsertIssueWithEvent(event({ occurredAt: '2026-11-10T10:05:00.000Z' }))
    await store.transitionIssueStatus(first.issue.id, 'acknowledged', ['open'], 'alice', '2026-11-10T10:06:00.000Z')
    await store.transitionIssueStatus(first.issue.id, 'resolved', ['acknowledged'], 'bob', '2026-11-10T10:07:00.000Z')

    const again = await store.upsertIssueWithEvent(event({ occurredAt: '2026-11-10T15:00:00.000Z' }))
    expect(again.reopened).toBe(true)
    expect(again.issue).toMatchObject({
      id: first.issue.id,
      status: 'open',
      reopenCount: 1,
      incidentCount: 1,
      count: 3,
      acknowledgedAt: null,
      acknowledgedBy: null,
      resolvedAt: null,
      resolvedBy: null,
    })
    expect(new Date(again.issue.incidentFirstSeen).toISOString()).toBe('2026-11-10T15:00:00.000Z')
    expect(new Date(again.issue.firstSeen).toISOString()).toBe('2026-11-10T10:00:00.000Z')
  })

  it('未 resolved 再 upsert：incident_count+1、reopen_count 不變、起點不動、acknowledged 保留', async () => {
    const first = await store.upsertIssueWithEvent(event())
    expect(first.issue).toMatchObject({ incidentCount: 1, reopenCount: 0 })
    await store.transitionIssueStatus(first.issue.id, 'acknowledged', ['open'], 'alice', '2026-11-10T10:01:00.000Z')
    const again = await store.upsertIssueWithEvent(event({ occurredAt: '2026-11-10T10:05:00.000Z' }))
    expect(again.reopened).toBe(false)
    expect(again.issue).toMatchObject({
      status: 'acknowledged',
      incidentCount: 2,
      reopenCount: 0,
      count: 2,
      acknowledgedBy: 'alice',
    })
    expect(new Date(again.issue.incidentFirstSeen).toISOString()).toBe('2026-11-10T10:00:00.000Z')
  })

  it('ignored 維持 ignored，不視為復發', async () => {
    const first = await store.upsertIssueWithEvent(event())
    await store.transitionIssueStatus(first.issue.id, 'ignored', ['open'], 'alice', '2026-11-10T10:01:00.000Z')
    const again = await store.upsertIssueWithEvent(event({ occurredAt: '2026-11-10T10:05:00.000Z' }))
    expect(again.reopened).toBe(false)
    expect(again.issue).toMatchObject({ status: 'ignored', reopenCount: 0, incidentCount: 2 })
  })
})
