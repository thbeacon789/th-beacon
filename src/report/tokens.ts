// 週報圖片色票。來源 app/globals.css:7-21（燈號對應 :597-605），改色票兩邊要一起改。
// Satori 不吃 CSS 變數，故在此抄成常數。
import type { HealthStatus } from '@/core/types'
import type { OverallStatus } from '@/core/security/view'

export const COLORS = {
  bg: '#312e81',
  fg: '#ffffff',
  gold: '#f5dca6',
  pink: '#ff7db2',
  yellow: '#ffd561',
  green: '#82ff9a',
  lilac: '#e2c7ff',
  line: 'rgba(226, 199, 255, 0.25)',
  lineStrong: 'rgba(226, 199, 255, 0.45)',
  panel: 'rgba(255, 255, 255, 0.05)',
  sunken: 'rgba(49, 46, 129, 0.55)',
  fgMuted: 'rgba(255, 255, 255, 0.72)',
} as const

export const GAUGE_GRADIENT = 'linear-gradient(90deg, #ff7db2, #ffd561, #82ff9a)'

export const HEALTH_COLOR: Record<HealthStatus, string> = {
  healthy: COLORS.green,
  degraded: COLORS.yellow,
  down: COLORS.pink,
}
export const HEALTH_SHAPE: Record<HealthStatus, 'circle' | 'triangle' | 'octagon'> = {
  healthy: 'circle',
  degraded: 'triangle',
  down: 'octagon',
}

export const SECURITY_COLOR: Record<OverallStatus, string> = {
  ok: COLORS.green,
  warn: COLORS.yellow,
  bad: COLORS.pink,
  unknown: COLORS.lilac,
}
export const SECURITY_SHAPE: Record<OverallStatus, 'circle' | 'triangle' | 'octagon'> = {
  ok: 'circle',
  warn: 'triangle',
  bad: 'octagon',
  unknown: 'circle',
}

export const FONT_BODY = 'New-Gen, Noto Sans TC'
export const FONT_TITLE = 'Aurora, Noto Sans TC'
export const FONT_PIXEL = 'Pixel, Noto Sans TC'
