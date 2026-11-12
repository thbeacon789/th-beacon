import type { Severity } from '@/core/types'
import { isSafeRunUrl, type DiagnosisCategory } from '@/core/heartbeat'
import { withAlertButtons } from './lifecycle-message'

// 通知時間一律台北時間、24 小時制、只到分鐘（例 18:25）。時區顯式指定：Vercel 執行環境是 UTC。
// hourCycle 'h23' 而非 hour12:false：部分 ICU 下後者會把午夜印成 24:00。
const ALERT_TIME = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** ISO 時間 → 台北 HH:mm；無法解析時原樣回傳。 */
export function formatAlertTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : ALERT_TIME.format(d)
}

export interface DiscordEmbedField {
  name: string
  value: string
  inline: boolean
}

export interface DiscordButton {
  type: 2
  /** 2 = secondary、3 = success */
  style: 2 | 3
  label: string
  custom_id: string
}

export interface DiscordActionRow {
  type: 1
  components: DiscordButton[]
}

export interface DiscordMessage {
  username: string
  /** 負責人 mention。embed 內的 mention 不會推播，必須放頂層 content。 */
  content?: string
  /** 一律帶上：外部錯誤內文若含 @everyone／@role 也不會被解析 */
  allowed_mentions: { parse: []; users?: [string] }
  /** 只有 bot 發送的訊息才帶（webhook 不支援互動按鈕） */
  components?: DiscordActionRow[]
  /** 以回覆形式掛在既有訊息下 */
  message_reference?: { message_id: string; fail_if_not_exists: false }
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

/** 純文字回覆（無 embeds、無 components），掛在既有訊息下 */
export interface DiscordReplyMessage {
  username: string
  content: string
  allowed_mentions: { parse: [] }
  message_reference: { message_id: string; fail_if_not_exists: false }
}

export type DiscordOutgoing = DiscordMessage | DiscordReplyMessage

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
  category?: DiagnosisCategory
  diagnosisReason?: string
  suggestion?: string
  diagnosisError?: string
}

// Discord field value 上限為 1024，留 buffer 截到 1000。
const FIELD_LIMIT = 1000
const TEXT_DETAIL_KEYS = ['summary', 'reason', 'lastRunAt'] as const

function pickString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key]
  if (typeof value !== 'string' || value === '') return undefined
  return value.length > FIELD_LIMIT ? `${value.slice(0, FIELD_LIMIT - 1)}…` : value
}

// metadata 來自外部（CI 回報／輪詢目標），一律白名單萃取，不整包倒進通知。
// runUrl 會被嵌進 markdown 連結 `[查看 run](${runUrl})`，scheme／字元白名單見 isSafeRunUrl
// （@/core/heartbeat）——與 web/queries.ts、heartbeat/payload.ts 共用同一份規則。
export function extractNotifyDetails(metadata: Record<string, unknown>): NotifyDetails {
  const details: NotifyDetails = {}
  for (const key of TEXT_DETAIL_KEYS) {
    const value = pickString(metadata, key)
    if (value !== undefined) details[key] = value
  }
  const diagnosisError = pickString(metadata, 'diagnosisError')
  if (diagnosisError !== undefined) details.diagnosisError = diagnosisError
  const diagnosis = metadata.diagnosis
  if (typeof diagnosis === 'object' && diagnosis !== null && !Array.isArray(diagnosis)) {
    const d = diagnosis as Record<string, unknown>
    if (d.category === 'env' || d.category === 'app') details.category = d.category
    const reason = pickString(d, 'reason')
    if (reason !== undefined) details.diagnosisReason = reason
    const suggestion = pickString(d, 'suggestion')
    if (suggestion !== undefined) details.suggestion = suggestion
  }
  const runUrl = pickString(metadata, 'runUrl')
  if (runUrl !== undefined && isSafeRunUrl(runUrl)) details.runUrl = runUrl
  return details
}

const CATEGORY_TITLE: Record<DiagnosisCategory, string> = { env: '環境問題', app: 'app 問題' }

const DETAIL_LABELS: Array<
  [key: 'summary' | 'reason' | 'lastRunAt' | 'diagnosisReason' | 'suggestion' | 'diagnosisError', label: string]
> = [
  ['summary', '失敗摘要'],
  ['diagnosisReason', '判定原因'],
  ['suggestion', '修正建議'],
  ['diagnosisError', 'AI 判讀失敗'],
  ['reason', '原因'],
  ['lastRunAt', '最後回報'],
]

const FREE_TEXT_KEYS = new Set<string>(['diagnosisReason', 'suggestion', 'diagnosisError'])

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
  ownerDiscordId?: string | null
  buttons?: { issueId: string; incidentSeq: number }
}): DiscordMessage {
  const description =
    params.message.length > DESCRIPTION_LIMIT
      ? `${params.message.slice(0, DESCRIPTION_LIMIT - 1)}…`
      : params.message
  const detailFields: DiscordEmbedField[] = []
  for (const [key, label] of DETAIL_LABELS) {
    const value = params.details?.[key]
    if (value !== undefined) {
      // 自由文字欄位（含 AI 輸出）：拆開 `](`，避免在 Discord embed 渲染成可點的 markdown 連結
      // 先中和再截斷：替換會讓字串變長，順序反了可能超過 Discord 1024 上限而整則被拒。
      let text = value
      if (FREE_TEXT_KEYS.has(key)) {
        text = value.replaceAll('](', '] (')
        if (text.length > FIELD_LIMIT) text = `${text.slice(0, FIELD_LIMIT - 1)}…`
      }
      detailFields.push({ name: label, value: text, inline: false })
    }
  }
  if (params.details?.runUrl !== undefined) {
    detailFields.push({
      name: 'CI Run',
      value: `[查看 run](${params.details.runUrl})`,
      inline: false,
    })
  }
  const owner = params.ownerDiscordId ?? null
  const message: DiscordMessage = {
    username: 'th-beacon',
    ...(owner !== null ? { content: `<@${owner}>` } : {}),
    allowed_mentions: owner !== null ? { parse: [], users: [owner] } : { parse: [] },
    embeds: [
      {
        title: `[${params.severity}] ${params.serviceName} — ${
          params.details?.category !== undefined
            ? CATEGORY_TITLE[params.details.category]
            : params.errorType
        }`,
        description,
        color: SEVERITY_COLOR[params.severity],
        ...(params.dashboardUrl !== undefined ? { url: params.dashboardUrl } : {}),
        fields: [
          { name: '次數', value: String(params.count), inline: true },
          { name: 'First seen', value: formatAlertTime(params.firstSeen), inline: true },
          { name: 'Last seen', value: formatAlertTime(params.lastSeen), inline: true },
          ...detailFields,
        ],
      },
    ],
  }
  return params.buttons !== undefined
    ? withAlertButtons(message, params.buttons.issueId, params.buttons.incidentSeq, ['ack', 'resolve'])
    : message
}
