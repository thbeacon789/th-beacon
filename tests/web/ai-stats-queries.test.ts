import { describe, expect, it, vi } from 'vitest'
import { PAGE_SIZE, fetchAllRows } from '@/web/ai-stats-queries'

const rows = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ({ i: offset + i }))

describe('fetchAllRows', () => {
  it('2500 列分三頁取完，range 依序 [0,999]、[1000,1999]、[2000,2999]', async () => {
    const all = rows(2500)
    const fetchPage = vi.fn(async (from: number, to: number) => ({
      data: all.slice(from, to + 1),
      error: null,
    }))
    const result = await fetchAllRows(fetchPage)
    expect(result).toHaveLength(2500)
    expect(PAGE_SIZE).toBe(1000)
    expect(fetchPage.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
  })

  it('剛好 1000 列 → 再取一頁得 0 列後停止', async () => {
    const all = rows(1000)
    const fetchPage = vi.fn(async (from: number, to: number) => ({
      data: all.slice(from, to + 1),
      error: null,
    }))
    const result = await fetchAllRows(fetchPage)
    expect(result).toHaveLength(1000)
    expect(fetchPage.mock.calls).toEqual([
      [0, 999],
      [1000, 1999],
    ])
  })

  it('任一頁 error → 拋錯（不可默默回部分資料）', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: rows(1000), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    await expect(fetchAllRows(fetchPage)).rejects.toThrow('boom')
  })
})
