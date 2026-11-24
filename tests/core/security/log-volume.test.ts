import { describe, it, expect } from 'vitest'
import { evaluateLogVolume } from '@/core/security/log-volume'
import type { LogSourceVolume } from '@/core/security/types'

const H = (h: number) => `2026-11-18T${String(h).padStart(2, '0')}:00:00.000Z`
function src(source: string, counts: number[], startHour = 0): LogSourceVolume {
  return { source, hourly: counts.map((count, i) => ({ hour: H(startHour + i), count })) }
}
const hist3 = (counts: number[]) => [0, 1, 2].map(() => [src('nginx', counts)])

describe('evaluateLogVolume', () => {
  it('hosted 回 na', () => {
    const r = evaluateLogVolume('hosted', [src('nginx', [100])], [])
    expect(r.check).toEqual({ status: 'na', summary: '' })
    expect(r.findings).toEqual([])
    expect(r.logVolume).toEqual([])
  })
  it('current 為 undefined 或空陣列回 na', () => {
    expect(evaluateLogVolume('vm', undefined, []).check.status).toBe('na')
    expect(evaluateLogVolume('vm', [], []).logVolume).toEqual([])
  })
  it('歷史少於 3 筆回 unknown「基準建立中」', () => {
    const r = evaluateLogVolume('vm', [src('nginx', [100])], [[src('nginx', [100])], [src('nginx', [100])]])
    expect(r.check).toEqual({ status: 'unknown', summary: '基準建立中' })
  })
  it('超過 5 倍且多 500 行以上判為 bad', () => {
    const r = evaluateLogVolume('vm', [src('nginx', [100, 700, 100])], hist3([100, 100, 100]))
    expect(r.check).toEqual({ status: 'bad', summary: '暴增 7 倍' })
    expect(r.logVolume[0].anomalousHours).toEqual([H(1)])
    expect(r.findings).toEqual([{
      check: 'logVolume', key: 'nginx', severity: 'high',
      title: 'nginx 在 01:00–02:00 UTC 的 log 量為平常的 7 倍',
      recommendation: '檢查該時段的存取紀錄與來源 IP，確認是攻擊、爬蟲或程式異常',
    }])
  })
  it('異常時段取最早到最晚異常小時的下一個整點', () => {
    const r = evaluateLogVolume('vm', [src('nginx', [100, 700, 100, 800])], hist3([100, 100, 100, 100]))
    expect(r.findings[0].title).toContain('01:00–04:00 UTC')
    expect(r.check.summary).toBe('暴增 8 倍')
  })
  it('超過 5 倍但未多 500 行不算異常', () => {
    const r = evaluateLogVolume('vm', [src('nginx', [90])], hist3([10]))
    expect(r.check).toEqual({ status: 'ok', summary: '正常' })
    expect(r.findings).toEqual([])
  })
  it('多 500 行但未達 5 倍不算異常', () => {
    expect(evaluateLogVolume('vm', [src('nginx', [1600])], hist3([1000])).check.status).toBe('ok')
  })
  it('恰為 5 倍不算異常（需嚴格大於）', () => {
    expect(evaluateLogVolume('vm', [src('nginx', [1000])], hist3([200])).check.status).toBe('ok')
  })
  it('歷史中標 error 的來源不計入基準筆數', () => {
    const history = [[src('nginx', [100])], [src('nginx', [100])], [{ source: 'nginx', error: true as const }]]
    const r = evaluateLogVolume('vm', [src('nginx', [100])], history)
    expect(r.check).toEqual({ status: 'unknown', summary: '基準建立中' })
  })
  it('current 來源標 error 回 unknown「來源讀不到」', () => {
    const r = evaluateLogVolume('vm', [{ source: 'nginx', error: true }], hist3([100]))
    expect(r.check).toEqual({ status: 'unknown', summary: '來源讀不到' })
    expect(r.logVolume[0].anomalousHours).toBeUndefined()
  })
  it('其他來源有異常時仍為 bad', () => {
    const history = [0, 1, 2].map(() => [src('nginx', [100]), src('app', [100])])
    const r = evaluateLogVolume('vm', [{ source: 'nginx', error: true }, src('app', [900])], history)
    expect(r.check.status).toBe('bad')
    expect(r.findings).toHaveLength(1)
  })
  it('基準為偶數個數取中間兩數平均', () => {
    // 歷史每筆 [100,300] → 排序 100,100,100,300,300,300 → 中位數 200；1100 > 1000 且多 900
    const r = evaluateLogVolume('vm', [src('nginx', [1100])], hist3([100, 300]))
    expect(r.check).toEqual({ status: 'bad', summary: '暴增 6 倍' })
  })
  it('基準為 0 時 summary 寫「暴增」', () => {
    const r = evaluateLogVolume('vm', [src('nginx', [600])], hist3([0]))
    expect(r.check).toEqual({ status: 'bad', summary: '暴增' })
  })
  it('基準為 0 的異常：title 為「暴增（平常幾乎為 0）」；與非 0 基準並存時 summary 仍為「暴增」', () => {
    const history = [0, 1, 2].map(() => [src('quiet', [0]), src('busy', [100])])
    const r = evaluateLogVolume('vm', [src('quiet', [600]), src('busy', [900])], history)
    expect(r.check).toEqual({ status: 'bad', summary: '暴增' })
    expect(r.findings.map((f) => f.title)).toEqual([
      'quiet 在 00:00–01:00 UTC 的 log 量暴增（平常幾乎為 0）',
      'busy 在 00:00–01:00 UTC 的 log 量為平常的 9 倍',
    ])
  })
  it('歷史快照內 hour 重複時取最後一筆', () => {
    const dup: LogSourceVolume = { source: 'nginx', hourly: [{ hour: H(0), count: 10 }, { hour: H(0), count: 100 }] }
    const r = evaluateLogVolume('vm', [src('nginx', [700])], [0, 1, 2].map(() => [dup]))
    expect(r.check).toEqual({ status: 'bad', summary: '暴增 7 倍' })
  })
  it('重複的 hour 取最後一筆', () => {
    const cur: LogSourceVolume = { source: 'nginx', hourly: [{ hour: H(1), count: 9000 }, { hour: H(1), count: 100 }] }
    const r = evaluateLogVolume('vm', [cur], hist3([100]))
    expect(r.check.status).toBe('ok')
  })
  it('某來源基準不足但另一來源足夠時為 unknown', () => {
    const history = [0, 1, 2].map(() => [src('nginx', [100])])
    const r = evaluateLogVolume('vm', [src('nginx', [100]), src('newsrc', [100])], history)
    expect(r.check).toEqual({ status: 'unknown', summary: '基準建立中' })
  })
})
