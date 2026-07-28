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

export function buildDiscordMessage(params: {
  serviceName: string
  severity: Severity
  errorType: string
  message: string
  count: number
  firstSeen: string
  lastSeen: string
  dashboardUrl?: string
}): DiscordMessage {
  const description =
    params.message.length > DESCRIPTION_LIMIT
      ? `${params.message.slice(0, DESCRIPTION_LIMIT - 1)}…`
      : params.message
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
        ],
      },
    ],
  }
}
