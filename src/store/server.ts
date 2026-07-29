import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import { SupabaseStore } from '@/store/supabase'
import { sendDiscordWebhook } from '@/notify/discord'
import type { NotifyDeps } from '@/pipeline/process-and-notify'

export function createServerStore(): SupabaseStore {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (url === undefined || key === undefined) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set')
  }
  return new SupabaseStore(createClient<Database>(url, key, { auth: { persistSession: false } }))
}

/** 空字串視同未設定——.env.example 與 Vercel 都可能留下空值，若不擋會拿 '' 去 POST 並記一筆假的 failed 通知 */
function envOrNull(name: string): string | null {
  const value = process.env[name]
  return value === undefined || value === '' ? null : value
}

export function createServerNotifyDeps(): NotifyDeps {
  const dashboardUrl = envOrNull('APP_URL')
  return {
    sender: sendDiscordWebhook,
    fallbackWebhookUrl: envOrNull('DISCORD_WEBHOOK_URL'),
    ...(dashboardUrl !== null ? { dashboardUrl } : {}),
  }
}

export function getCronSecret(): string {
  const secret = process.env.CRON_SECRET
  if (secret === undefined || secret === '') {
    throw new Error('CRON_SECRET must be set')
  }
  return secret
}
