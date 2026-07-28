import { describe, it, expect, beforeEach } from 'vitest'
import { processAndNotify } from '@/pipeline/process-and-notify'
import { InMemoryStore } from '@/store/memory'
import type { NotifyDeps } from '@/pipeline/process-and-notify'
import type { DiscordMessage } from '@/notify/message'
import type { ServiceRecord } from '@/store/contracts'
import type { CanonicalEvent } from '@/core/types'

const now = new Date('2026-07-28T10:10:00.000Z')

const svc: ServiceRecord = {
  id: 's-1',
  name: 'svc-a',
  healthWindowMinutes: 15,
  healthFailureThreshold: 2,
  healthStatus: 'healthy',
  poll: null,
  discordWebhookUrl: 'https://discord/webhook',
}

const event = (over: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  serviceId: 's-1',
  source: 'push',
  level: 'error',
  errorType: 'TypeError',
  message: 'boom',
  fingerprint: 'fp-1',
  occurredAt: '2026-07-28T10:09:00.000Z',
  metadata: {},
  ...over,
})

function fakeSender(result: { ok: true } | { ok: false; reason: string } = { ok: true }) {
  const sent: Array<{ url: string; message: DiscordMessage }> = []
  const deps: NotifyDeps = {
    sender: async (url, message) => {
      sent.push({ url, message })
      return result
    },
    fallbackWebhookUrl: null,
  }
  return { deps, sent }
}

describe('processAndNotify', () => {
  let store: InMemoryStore
  beforeEach(() => {
    store = new InMemoryStore()
    store.seedService(svc)
  })

  it('P2 issue: pipeline runs, nothing sent', async () => {
    const { deps, sent } = fakeSender()
    const result = await processAndNotify(store, deps, event(), now)
    expect(result.notified).toBe(false)
    expect(result.notifyReason).toBe('below_threshold')
    expect(sent).toHaveLength(0)
  })

  it('first P1: sends embed to per-service webhook and records sent', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    const result = await processAndNotify(store, deps, event(), now)
    expect(result.notified).toBe(true)
    expect(result.notifyReason).toBe('first')
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://discord/webhook')
    expect(sent[0].message.embeds[0].title).toBe('[P1] svc-a — TypeError')
    expect(await store.getLatestSentNotification('s-1', result.issue.fingerprint)).toEqual({
      severity: 'P1',
      sentAt: now.toISOString(),
    })
  })

  it('cooldown suppresses repeat; escalation resends', async () => {
    store.seedRule(null, { id: 'p1', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    await processAndNotify(store, deps, event(), now)
    const repeat = await processAndNotify(store, deps, event(), now)
    expect(repeat.notified).toBe(false)
    expect(repeat.notifyReason).toBe('cooldown')
    expect(sent).toHaveLength(1)

    store.seedRule(null, {
      id: 'p0',
      priority: 20,
      severity: 'P0',
      match: { minCountInWindow: 3, windowMinutes: 60 },
    })
    const escalated = await processAndNotify(store, deps, event(), now)
    expect(escalated.notified).toBe(true)
    expect(escalated.notifyReason).toBe('escalation')
    expect(sent).toHaveLength(2)
    expect(sent[1].message.embeds[0].title).toBe('[P0] svc-a — TypeError')
  })

  it('sender failure records failed, pipeline result intact, next event retries', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const failing = fakeSender({ ok: false, reason: 'http 500' })
    const result = await processAndNotify(store, failing.deps, event(), now)
    expect(result.notified).toBe(false)
    expect(result.notifyReason).toBe('first')
    expect(result.issue.severity).toBe('P1') // 管線不受影響
    expect(await store.getLatestSentNotification('s-1', result.issue.fingerprint)).toBeNull() // failed 不計

    const ok = fakeSender()
    const retry = await processAndNotify(store, ok.deps, event(), now)
    expect(retry.notified).toBe(true)
    expect(retry.notifyReason).toBe('first') // 仍無 sent 紀錄 → first
  })

  it('falls back to global webhook; skips with no_webhook when neither set', async () => {
    store.seedService({ ...svc, id: 's-2', name: 'svc-b', discordWebhookUrl: null })
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    deps.fallbackWebhookUrl = 'https://discord/global'
    const viaFallback = await processAndNotify(store, deps, event({ serviceId: 's-2' }), now)
    expect(viaFallback.notified).toBe(true)
    expect(sent[0].url).toBe('https://discord/global')

    const none = fakeSender()
    store.seedService({ ...svc, id: 's-3', name: 'svc-c', discordWebhookUrl: null })
    const skipped = await processAndNotify(store, none.deps, event({ serviceId: 's-3', fingerprint: 'fp-3' }), now)
    expect(skipped.notified).toBe(false)
    expect(skipped.notifyReason).toBe('no_webhook')
    expect(none.sent).toHaveLength(0)
  })

  it('duplicate events skip notification evaluation', async () => {
    store.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    await processAndNotify(store, deps, event({ source: 'poll', metadata: { externalId: 'x' } }), now)
    const dup = await processAndNotify(store, deps, event({ source: 'poll', metadata: { externalId: 'x' } }), now)
    expect(dup.notifyReason).toBe('duplicate')
    expect(sent).toHaveLength(1)
  })

  it('notify-stage store failure never breaks the pipeline result', async () => {
    class ThrowingNotifyStore extends InMemoryStore {
      async getLatestSentNotification(): Promise<never> {
        throw new Error('db blip')
      }
    }
    const store2 = new ThrowingNotifyStore()
    store2.seedService(svc)
    store2.seedRule(null, { id: 'r', priority: 10, severity: 'P1', match: {} })
    const { deps, sent } = fakeSender()
    const result = await processAndNotify(store2, deps, event(), now)
    expect(result.issue.severity).toBe('P1') // 管線結果完整
    expect(result.notified).toBe(false)
    expect(result.notifyReason).toBe('notify_error')
    expect(sent).toHaveLength(0)
  })
})
