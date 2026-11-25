import { describe, it, expect, vi } from 'vitest'
import { runWeeklyReport, type RunWeeklyReportDeps } from '@/report/run-weekly-report'
import type { WeeklyReportInput } from '@/core/weekly-report'

// 2026-11-23 是週一；報告窗為 11/16–11/22（台北時間）
const NOW = new Date('2026-11-23T01:00:00Z')

const input: WeeklyReportInput = {
  now: NOW,
  services: [{ id: 's1', name: 'altinvest', healthStatus: 'healthy', openCounts: { P0: 0, P1: 0, P2: 0 } }],
  issues: [],
  healthFailEvents: [],
  alertsSent: 0,
  securityRows: [{ serviceId: 's1', overall: 'ok', stale: false }],
  securityFindings: [],
}

function makeDeps(over: Partial<RunWeeklyReportDeps> = {}) {
  const send = vi.fn(async () => ({ ok: true as const }))
  const deps: RunWeeklyReportDeps = {
    now: NOW,
    dashboardUrl: null,
    load: async () => input,
    render: async () => new Uint8Array([1, 2, 3]),
    send,
    ...over,
  }
  return { deps, send }
}

describe('runWeeklyReport', () => {
  it('正常：每頁一個附件、檔名遞增、content 首行含標題', async () => {
    const { deps, send } = makeDeps()
    const result = await runWeeklyReport(deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.imageFailed).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    const [content, files] = send.mock.calls[0] as unknown as [string, Array<{ filename: string }>]
    expect(content.split('\n')[0]).toContain('TH-BEACON 週報')
    expect(files.length).toBe(result.pages)
    expect(files.map((f) => f.filename)).toEqual(files.map((_, i) => `weekly-report-${i + 1}.png`))
  })

  it('render 失敗：改送純文字、files 為空、imageFailed', async () => {
    const { deps, send } = makeDeps({ render: async () => { throw new Error('boom') } })
    const result = await runWeeklyReport(deps)
    expect(result).toMatchObject({ ok: true, imageFailed: true })
    const [content, files] = send.mock.calls[0] as unknown as [string, unknown[]]
    expect(files).toEqual([])
    expect(content).toContain('（圖片產生失敗）')
  })

  it('load 失敗：不呼叫 send', async () => {
    const { deps, send } = makeDeps({ load: async () => { throw new Error('db down') } })
    const result = await runWeeklyReport(deps)
    expect(result).toMatchObject({ ok: false, stage: 'load' })
    expect(send).not.toHaveBeenCalled()
  })

  it('send 失敗：回 stage=send 與 reason', async () => {
    const { deps } = makeDeps({ send: async () => ({ ok: false, reason: 'http 403' }) })
    const result = await runWeeklyReport(deps)
    expect(result).toEqual({ ok: false, stage: 'send', reason: 'http 403' })
  })
})
