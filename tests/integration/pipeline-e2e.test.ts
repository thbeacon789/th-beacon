import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createServiceRoleClient, cleanDatabase } from './helpers'
import { SupabaseStore } from '@/store/supabase'
import { processEvent } from '@/pipeline/process-event'
import { normalizePushEvent, normalizePolledError } from '@/core/normalize'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/db/database.types'

let client: SupabaseClient<Database>
let store: SupabaseStore
let serviceId: string

const now = new Date('2026-07-27T10:10:00.000Z')
const receivedAt = new Date('2026-07-27T10:09:00.000Z')

beforeAll(() => {
  client = createServiceRoleClient()
  store = new SupabaseStore(client)
})

beforeEach(async () => {
  await cleanDatabase(client)
  const { data, error } = await client
    .from('services')
    .insert({ name: 'svc-e2e' })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
})

describe('pipeline end-to-end against local Supabase', () => {
  it('push event flows: normalize → upsert → rule severity → service health persisted', async () => {
    await client.from('triage_rules').insert({
      service_id: null,
      priority: 10,
      severity: 'P0',
      tags: ['db'],
      match: { messageIncludes: 'db down' } as Json,
    })

    const canonical = normalizePushEvent(
      serviceId,
      { message: 'db down: connection refused', errorType: 'DBError' },
      receivedAt,
    )
    const result = await processEvent(store, canonical, now)

    expect(result.issue.severity).toBe('P0')
    expect(result.health).toBe('down')

    const { data: svc } = await client
      .from('services')
      .select('health_status')
      .eq('id', serviceId)
      .single()
    expect(svc?.health_status).toBe('down')

    const { data: issueRow } = await client
      .from('issues')
      .select('severity,tags,count')
      .eq('service_id', serviceId)
      .single()
    expect(issueRow).toMatchObject({ severity: 'P0', tags: ['db'], count: 1 })
  })

  it('polled errors with same externalId only count once end-to-end', async () => {
    const raw = { message: 'timeout', errorType: 'Timeout', externalId: 'ext-9' }
    await processEvent(store, normalizePolledError(serviceId, raw, receivedAt), now)
    const second = await processEvent(store, normalizePolledError(serviceId, raw, receivedAt), now)

    expect(second.duplicate).toBe(true)
    const { data: issueRow } = await client
      .from('issues')
      .select('count')
      .eq('service_id', serviceId)
      .single()
    expect(issueRow?.count).toBe(1)
  })

  it('unknown service id rejects', async () => {
    const canonical = normalizePushEvent(
      '00000000-0000-0000-0000-000000000001',
      { message: 'x' },
      receivedAt,
    )
    await expect(processEvent(store, canonical, now)).rejects.toThrow(/unknown service/)
  })
})
