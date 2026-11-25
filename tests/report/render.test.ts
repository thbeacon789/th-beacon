import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { paginateReport, PAGE_WIDTH } from '@/core/weekly-report-pages'
import { renderReportPage } from '@/report/render'
import { makeReport, manyRows } from './fixtures'

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

async function renderAll(report = makeReport()) {
  const pages = paginateReport(report)
  const out: Array<{ page: (typeof pages)[number]; png: Uint8Array }> = []
  for (const page of pages) out.push({ page, png: await renderReportPage(report, page, { dashboardUrl: 'th-beacon.vercel.app' }) })
  const dir = process.env.REPORT_SNAPSHOT_DIR
  return { out, dir }
}

function expectPng(png: Uint8Array, width: number, height: number) {
  expect(Array.from(png.slice(0, 8))).toEqual(SIG)
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
  expect(dv.getUint32(16)).toBe(width)
  expect(dv.getUint32(20)).toBe(height)
}

describe('renderReportPage', () => {
  it('單頁報告輸出 1200 x page.height 的 PNG', async () => {
    const { out, dir } = await renderAll()
    expect(out).toHaveLength(1)
    for (const { page, png } of out) expectPng(png, PAGE_WIDTH, page.height)
    if (dir) { mkdirSync(dir, { recursive: true }); out.forEach((o, i) => writeFileSync(path.join(dir, `single-${i}.png`), o.png)) }
  }, 30000)

  it('含 overflow 的多頁報告每頁尺寸正確', async () => {
    const report = makeReport({ longStanding: manyRows(60), recurring: manyRows(30) })
    const { out, dir } = await renderAll(report)
    expect(out.length).toBeGreaterThan(1)
    for (const { page, png } of out) expectPng(png, PAGE_WIDTH, page.height)
    if (dir) { mkdirSync(dir, { recursive: true }); out.forEach((o, i) => writeFileSync(path.join(dir, `multi-${i}.png`), o.png)) }
  }, 60000)

  it('ok 報告（全部正常、單筆長期未處理）也能渲染', async () => {
    const base = makeReport()
    const report = makeReport({
      verdict: 'ok', headline: '5/5 服務正常 · 另有 1 筆既有待處理',
      stats: { pollFailures: 0, pollFailureServices: 0, newIssues: 0, resolvedIssues: 0, alertsSent: 0 },
      services: base.services.map((s) => ({ ...s, health: 'healthy' as const, openIssues: 0, pollFailures: 0 })),
      security: base.security.slice(0, 2).map((s) => ({ ...s, status: 'ok' as const, openFindings: { high: 0, medium: 0, low: 0 } })),
      longStanding: [base.longStanding[1]], recurring: [],
    })
    const { out, dir } = await renderAll(report)
    for (const { page, png } of out) expectPng(png, PAGE_WIDTH, page.height)
    if (dir) { mkdirSync(dir, { recursive: true }); out.forEach((o, i) => writeFileSync(path.join(dir, `ok-${i}.png`), o.png)) }
  }, 30000)

  it('dashboardUrl 為 null 也能渲染', async () => {
    const report = makeReport()
    const page = paginateReport(report)[0]
    const png = await renderReportPage(report, page, { dashboardUrl: null })
    expectPng(png, PAGE_WIDTH, page.height)
  }, 30000)
})
