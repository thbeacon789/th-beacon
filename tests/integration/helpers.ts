import { execSync } from 'node:child_process'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

function readVar(output: string, name: string): string {
  const match = output.match(new RegExp(`^${name}="?([^"\\n]+)"?$`, 'm'))
  if (match === null) {
    throw new Error(`supabase status output missing ${name} — is the local stack running? (supabase start)`)
  }
  return match[1]
}

export function getLocalSupabaseEnv(): { url: string; serviceRoleKey: string } {
  const env = execSync('supabase status -o env', { encoding: 'utf8' })
  return { url: readVar(env, 'API_URL'), serviceRoleKey: readVar(env, 'SERVICE_ROLE_KEY') }
}

export function createServiceRoleClient(): SupabaseClient<Database> {
  const { url, serviceRoleKey } = getLocalSupabaseEnv()
  return createClient<Database>(url, serviceRoleKey, { auth: { persistSession: false } })
}

export async function cleanDatabase(client: SupabaseClient<Database>): Promise<void> {
  // FK 順序：子表先刪
  for (const table of ['events', 'notifications', 'issues', 'triage_rules', 'services'] as const) {
    const { error } = await client.from(table).delete().neq('id', NIL_UUID)
    if (error) throw new Error(`clean ${table} failed: ${error.message}`)
  }
}
