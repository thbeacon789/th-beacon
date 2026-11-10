import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/db/database.types'
import { SupabaseStore } from '@/store/supabase'
import { sendDiscordWebhook } from '@/notify/discord'
import { createDiscordBot } from '@/notify/discord-bot'
import type { NotifyDeps } from '@/pipeline/process-and-notify'
import Anthropic from '@anthropic-ai/sdk'
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation'
import { getVercelOidcToken } from '@vercel/oidc'
import { createClaudeTriager, type Triager } from '@/triage/claude'

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

export function createServerNotifyDeps(opts: { budget?: { remaining: number } | null } = {}): NotifyDeps {
  const dashboardUrl = envOrNull('APP_URL')
  const botToken = envOrNull('DISCORD_BOT_TOKEN')
  const alertChannelId = envOrNull('DISCORD_ALERT_CHANNEL_ID')
  // 四個變數任一缺 -> bot 模式關閉（否則按鈕會因互動端點缺 key 而成死按鈕）
  const botEnabled = botToken !== null && alertChannelId !== null && getDiscordInteractionConfig() !== null
  return {
    triage: { triager: createServerTriager(), budget: opts.budget ?? null },
    sender: sendDiscordWebhook,
    fallbackWebhookUrl: envOrNull('DISCORD_WEBHOOK_URL'),
    bot:
      botEnabled && botToken !== null && alertChannelId !== null
        ? createDiscordBot({ token: botToken, channelId: alertChannelId })
        : null,
    ...(dashboardUrl !== null ? { dashboardUrl } : {}),
  }
}

/** Discord Interactions 驗簽用設定；兩者皆有才回，否則 null（端點應拒絕服務） */
export function getDiscordInteractionConfig(): { publicKey: string; applicationId: string } | null {
  const publicKey = envOrNull('DISCORD_PUBLIC_KEY')
  const applicationId = envOrNull('DISCORD_APPLICATION_ID')
  return publicKey !== null && applicationId !== null ? { publicKey, applicationId } : null
}

export function getCronSecret(): string {
  const secret = process.env.CRON_SECRET
  if (secret === undefined || secret === '') {
    throw new Error('CRON_SECRET must be set')
  }
  return secret
}

const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com'

/**
 * Claude 判級 adapter（Vercel OIDC → Anthropic WIF）。四個 ANTHROPIC_* 變數缺任何一個 → null（停用 AI，走規則）。
 * 刻意不讀 ANTHROPIC_API_KEY：它會蓋過 WIF。
 */
export function createServerTriager(): Triager | null {
  const federationRuleId = envOrNull('ANTHROPIC_FEDERATION_RULE_ID')
  const organizationId = envOrNull('ANTHROPIC_ORGANIZATION_ID')
  const serviceAccountId = envOrNull('ANTHROPIC_SERVICE_ACCOUNT_ID')
  const workspaceId = envOrNull('ANTHROPIC_WORKSPACE_ID')
  if (federationRuleId === null || organizationId === null || serviceAccountId === null || workspaceId === null) {
    return null
  }
  const client = new Anthropic({
    baseURL: ANTHROPIC_API_BASE_URL,
    credentials: oidcFederationProvider({
      // 每次交換才取 Vercel OIDC token（不在頂層呼叫、不自行快取）
      identityTokenProvider: () => getVercelOidcToken({ audience: ANTHROPIC_API_BASE_URL }),
      federationRuleId,
      organizationId,
      serviceAccountId,
      workspaceId,
      baseURL: ANTHROPIC_API_BASE_URL,
      fetch: globalThis.fetch,
    }),
  })
  return createClaudeTriager(client)
}
