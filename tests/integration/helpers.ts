import { execSync } from 'node:child_process'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

export function createServiceRoleClient(): SupabaseClient<Database> {
  const env = execSync('supabase status -o env', { encoding: 'utf8' })
  const url = readVar(env, 'API_URL')
  const key = readVar(env, 'SERVICE_ROLE_KEY')
  return createClient<Database>(url, key, { auth: { persistSession: false } })
}

function readVar(output: string, name: string): string {
  const match = output.match(new RegExp(`^${name}="?([^"\\n]+)"?$`, 'm'))
  if (match === null) {
    throw new Error(`supabase status output missing ${name} — is the local stack running? (supabase start)`)
  }
  return match[1]
}

export async function cleanDatabase(client: SupabaseClient<Database>): Promise<void> {
  // FK 順序：子表先刪
  for (const table of ['events', 'notifications', 'issues', 'triage_rules', 'services'] as const) {
    const { error } = await client.from(table).delete().neq('id', NIL_UUID)
    if (error) throw new Error(`clean ${table} failed: ${error.message}`)
  }
}
