import type { CanonicalEvent } from '@/core/types'
import { computeFingerprint } from '@/core/fingerprint'

export type HeartbeatRunStatus = 'pass' | 'fail'

export interface HeartbeatDefinition {
  name: string
  intervalSeconds: number
  graceSeconds: number
  lastRunAt: string | null
  createdAt: string
}

// 名稱走 errorType 位置參與雜湊：computeFingerprint 只正規化 message，
// 其中 \b\d+\b 會被換成 <n>，若名稱只從 message 進入，daily-2 與 daily-3
// 會產生相同指紋而被錯誤聚合成同一筆 issue。
export function heartbeatFingerprint(
  serviceId: string,
  errorType: string,
  name: string,
): string {
  return computeFingerprint({ serviceId, errorType: `${errorType}:${name}`, message: '' })
}

export function heartbeatDueAt(hb: HeartbeatDefinition): Date {
  const base = hb.lastRunAt ?? hb.createdAt
  return new Date(new Date(base).getTime() + hb.intervalSeconds * 1000)
}

export function isHeartbeatOverdue(hb: HeartbeatDefinition, now: Date): boolean {
  return now.getTime() > heartbeatDueAt(hb).getTime() + hb.graceSeconds * 1000
}

export function synthesizeHeartbeatMissedEvent(
  serviceId: string,
  hb: HeartbeatDefinition,
  occurredAt: Date,
): CanonicalEvent {
  const errorType = 'heartbeat_missed'
  // 訊息刻意只含名稱（不含逾期秒數等變動值），確保同一心跳的重複掃描聚合成同一 issue。
  const message = `Heartbeat missed: ${hb.name}`
  const overdueMs = occurredAt.getTime() - heartbeatDueAt(hb).getTime()
  return {
    serviceId,
    source: 'poll',
    level: 'error',
    errorType,
    message,
    fingerprint: heartbeatFingerprint(serviceId, errorType, hb.name),
    occurredAt: occurredAt.toISOString(),
    metadata: {
      heartbeat: hb.name,
      intervalSeconds: hb.intervalSeconds,
      graceSeconds: hb.graceSeconds,
      lastRunAt: hb.lastRunAt,
      overdueSeconds: Math.floor(overdueMs / 1000),
    },
  }
}

export interface HeartbeatFailurePayload {
  runUrl?: string
  summary?: string
}

export function normalizeHeartbeatFailure(
  serviceId: string,
  hb: HeartbeatDefinition,
  payload: HeartbeatFailurePayload,
  occurredAt: Date,
): CanonicalEvent {
  const errorType = 'test_failure'
  const message = `Test failed: ${hb.name}`
  return {
    serviceId,
    source: 'push',
    level: 'error',
    errorType,
    message,
    fingerprint: heartbeatFingerprint(serviceId, errorType, hb.name),
    occurredAt: occurredAt.toISOString(),
    metadata: {
      heartbeat: hb.name,
      ...(payload.runUrl !== undefined ? { runUrl: payload.runUrl } : {}),
      ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
    },
  }
}
