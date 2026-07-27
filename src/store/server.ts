import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import { SupabaseStore } from '@/store/supabase'

export function createServerStore(): SupabaseStore {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url === undefined || key === undefined) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  }
  return new SupabaseStore(createClient<Database>(url, key, { auth: { persistSession: false } }))
}
