/**
 * Markdown 標題 → 錨點 id。
 *
 * 由建置期的 scripts/build-docs.mts 使用（產生 <h2 id> 與頁首目錄），
 * 執行期不會用到——但放在 src/ 下才能被 vitest 以 @/ alias 匯入測試。
 *
 * 保留中文：文件標題以中文為主，若只留 ASCII，「1. HMAC 驗證」與
 * 「2. 推送錯誤事件」會雙雙塌成 "1" / "2" 之類的無意義片段，甚至互相碰撞。
 */

export function slugify(text: string): string {
  const cleaned = text
    .replace(/<[^>]+>/g, '') // inline code 等會先被渲染成標籤
    .replace(/[`*_~]/g, '') // 未渲染時的 markdown 強調記號
    .toLowerCase()
  const slug = cleaned
    // \p{Letter} 涵蓋 CJK，故中文標題會原樣保留；其餘（空白、標點、全形括號）併成單一連字號
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  // 純標點標題（如「---」）會清空，仍需一個合法的 id
  return slug === '' ? 'section' : slug
}

/**
 * 產生一個帶記憶的 slug 函式：同名標題第二次出現時補上序號，
 * 避免兩個錨點搶同一個 id（瀏覽器只會跳到第一個）。
 */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>()
  return (text: string) => {
    const base = slugify(text)
    const used = seen.get(base) ?? 0
    seen.set(base, used + 1)
    return used === 0 ? base : `${base}-${used + 1}`
  }
}
