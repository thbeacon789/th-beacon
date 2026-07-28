import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient, cleanDatabase, getLocalSupabaseEnv } from './helpers'
import type { Database } from '@/db/database.types'

let admin: SupabaseClient<Database>
let userClient: SupabaseClient<Database>
let anonClient: SupabaseClient<Database>
let serviceId: string

const email = 'dash-test@example.com'
const password = 'test-password-123'

beforeAll(async () => {
  const { url, serviceRoleKey } = getLocalSupabaseEnv()
  admin = createServiceRoleClient()

  // 讀 anon key（supabase status -o env 的 ANON_KEY；鍵名以實跑為準）
  const { execSync } = await import('node:child_process')
  const statusEnv = execSync('supabase status -o env', { encoding: 'utf8' })
  const anonKey = statusEnv.match(/^ANON_KEY="?([^"\n]+)"?$/m)?.[1]
  if (anonKey === undefined) throw new Error('ANON_KEY not found in supabase status')

  anonClient = createClient<Database>(url, anonKey, { auth: { persistSession: false } })

  // 建測試使用者（冪等：先刪同 email）
  const { data: list } = await admin.auth.admin.listUsers()
  for (const u of list.users.filter((u) => u.email === email)) {
    await admin.auth.admin.deleteUser(u.id)
  }
  const { error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createError) throw createError

  userClient = createClient<Database>(url, anonKey, { auth: { persistSession: false } })
  const { error: signInError } = await userClient.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError
})

beforeEach(async () => {
  await cleanDatabase(admin)
  const { data, error } = await admin
    .from('services')
    .insert({ name: 'svc-rls', webhook_secret: 'super-secret' })
    .select('id')
    .single()
  if (error) throw error
  serviceId = data.id
  const { error: issueError } = await admin.from('issues').insert({
    service_id: serviceId,
    fingerprint: 'fp-rls',
    first_seen: '2026-07-28T10:00:00.000Z',
    last_seen: '2026-07-28T10:00:00.000Z',
    level: 'error',
    error_type: 'X',
    message: 'visible to authenticated',
  })
  if (issueError) throw issueError
})

describe('dashboard RLS boundary', () => {
  it('authenticated user can read issues', async () => {
    const { data, error } = await userClient.from('issues').select('message')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].message).toBe('visible to authenticated')
  })

  it('authenticated user cannot read services (secrets stay server-side)', async () => {
    const { data } = await userClient.from('services').select('webhook_secret')
    expect(data).toEqual([]) // 無 policy → deny → 空
  })

  it('authenticated user cannot read events or notifications', async () => {
    expect((await userClient.from('events').select('id')).data).toEqual([])
    expect((await userClient.from('notifications').select('id')).data).toEqual([])
  })

  it('anonymous can read nothing', async () => {
    expect((await anonClient.from('issues').select('id')).data).toEqual([])
    expect((await anonClient.from('services').select('id')).data).toEqual([])
  })
})
