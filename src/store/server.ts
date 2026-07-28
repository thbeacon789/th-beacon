import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import { SupabaseStore } from '@/store/supabase'
import { sendDiscordWebhook } from '@/notify/discord'
import type { NotifyDeps } from '@/pipeline/process-and-notify'

export function createServerStore(): SupabaseStore {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (url === undefined || key === undefined) {
    throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  }
  return new SupabaseStore(createClient<Database>(url, key, { auth: { persistSession: false } }))
}

export function createServerNotifyDeps(): NotifyDeps {
  return {
    sender: sendDiscordWebhook,
    fallbackWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? null,
    ...(process.env.APP_URL !== undefined ? { dashboardUrl: process.env.APP_URL } : {}),
  }
}

export function getCronSecret(): string {
  const secret = process.env.CRON_SECRET
  if (secret === undefined || secret === '') {
    throw new Error('CRON_SECRET must be set')
  }
  return secret
}
