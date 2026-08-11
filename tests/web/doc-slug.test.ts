import { describe, expect, it } from 'vitest'
import { createSlugger, slugify } from '@/web/doc-slug'

describe('slugify', () => {
  it('保留中文，把空白與標點併成連字號', () => {
    expect(slugify('1. HMAC 驗證（ingest 與 heartbeat 共用）')).toBe(
      '1-hmac-驗證-ingest-與-heartbeat-共用',
    )
  })

  it('剝掉 inline code 的反引號與破折號', () => {
    expect(slugify('2. `POST /api/ingest` — 推送錯誤事件')).toBe('2-post-api-ingest-推送錯誤事件')
  })

  it('剝掉已渲染成 HTML 的標籤', () => {
    expect(slugify('3. <code>POST /api/heartbeat</code> — 具名心跳')).toBe(
      '3-post-api-heartbeat-具名心跳',
    )
  })

  it('去除頭尾多餘的連字號', () => {
    expect(slugify('  （附註）  ')).toBe('附註')
  })

  it('純標點的標題退回 section', () => {
    expect(slugify('※ ——「」')).toBe('section')
  })

  it('英文一律小寫', () => {
    expect(slugify('Request Body')).toBe('request-body')
  })
})

describe('createSlugger', () => {
  it('同名標題補序號，不讓兩個錨點搶同一個 id', () => {
    const slug = createSlugger()
    expect(slug('Request body')).toBe('request-body')
    expect(slug('Request body')).toBe('request-body-2')
    expect(slug('Request body')).toBe('request-body-3')
  })

  it('不同標題互不影響', () => {
    const slug = createSlugger()
    expect(slug('錯誤回應')).toBe('錯誤回應')
    expect(slug('成功回應')).toBe('成功回應')
    expect(slug('錯誤回應')).toBe('錯誤回應-2')
  })

  it('去重是在正規化之後才判斷的', () => {
    const slug = createSlugger()
    expect(slug('Request Body')).toBe('request-body')
    expect(slug('request body')).toBe('request-body-2')
  })
})
