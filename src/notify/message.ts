import type { Severity } from '@/core/types'

export interface DiscordEmbedField {
  name: string
  value: string
  inline: boolean
}

export interface DiscordMessage {
  username: string
  embeds: [
    {
      title: string
      description: string
      color: number
      url?: string
      fields: DiscordEmbedField[]
    },
  ]
}

const SEVERITY_COLOR: Record<Severity, number> = {
  P0: 0xe74c3c,
  P1: 0xe67e22,
  P2: 0x95a5a6,
}

const DESCRIPTION_LIMIT = 500

export interface NotifyDetails {
  summary?: string
  runUrl?: string
  reason?: string
  lastRunAt?: string
}

// Discord field value 上限為 1024，留 buffer 截到 1000。
const FIELD_LIMIT = 1000
const TEXT_DETAIL_KEYS = ['summary', 'reason', 'lastRunAt'] as const

function pickString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key]
  if (typeof value !== 'string' || value === '') return undefined
  return value.length > FIELD_LIMIT ? `${value.slice(0, FIELD_LIMIT - 1)}…` : value
}

// runUrl 會被嵌進 markdown 連結 `[查看 run](${runUrl})`，因此除了 scheme 檢查，
// 整串都必須落在合法 URL 字元白名單內——尤其要擋掉 `(`、`)`、空白（含換行/tab）與反引號，
// 否則可被注入內容提前閉合連結、偽造第二個連結（釣魚）。用白名單而非黑名單更穩固。
const RUN_URL_PATTERN = /^https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]+$/i

// metadata 來自外部（CI 回報／輪詢目標），一律白名單萃取，不整包倒進通知。
export function extractNotifyDetails(metadata: Record<string, unknown>): NotifyDetails {
  const details: NotifyDetails = {}
  for (const key of TEXT_DETAIL_KEYS) {
    const value = pickString(metadata, key)
    if (value !== undefined) details[key] = value
  }
  const runUrl = pickString(metadata, 'runUrl')
  if (runUrl !== undefined && RUN_URL_PATTERN.test(runUrl)) details.runUrl = runUrl
  return details
}

const DETAIL_LABELS: Array<[key: (typeof TEXT_DETAIL_KEYS)[number], label: string]> = [
  ['summary', '失敗摘要'],
  ['reason', '原因'],
  ['lastRunAt', '最後回報'],
]

export function buildDiscordMessage(params: {
  serviceName: string
  severity: Severity
  errorType: string
  message: string
  count: number
  firstSeen: string
  lastSeen: string
  dashboardUrl?: string
  details?: NotifyDetails
}): DiscordMessage {
  const description =
    params.message.length > DESCRIPTION_LIMIT
      ? `${params.message.slice(0, DESCRIPTION_LIMIT - 1)}…`
      : params.message
  const detailFields: DiscordEmbedField[] = []
  for (const [key, label] of DETAIL_LABELS) {
    const value = params.details?.[key]
    if (value !== undefined) detailFields.push({ name: label, value, inline: false })
  }
  if (params.details?.runUrl !== undefined) {
    detailFields.push({
      name: 'CI Run',
      value: `[查看 run](${params.details.runUrl})`,
      inline: false,
    })
  }
  return {
    username: 'th-beacon',
    embeds: [
      {
        title: `[${params.severity}] ${params.serviceName} — ${params.errorType}`,
        description,
        color: SEVERITY_COLOR[params.severity],
        ...(params.dashboardUrl !== undefined ? { url: params.dashboardUrl } : {}),
        fields: [
          { name: '次數', value: String(params.count), inline: true },
          { name: 'First seen', value: params.firstSeen, inline: true },
          { name: 'Last seen', value: params.lastSeen, inline: true },
          ...detailFields,
        ],
      },
    ],
  }
}
