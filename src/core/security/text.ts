// 注意：本檔會被 Node 直接執行（type stripping）。
/** 依 code point 截斷（不會在 surrogate pair 中間切開，避免留下孤立的 surrogate） */
export function truncateCodePoints(str: string, max: number): string {
  if (str.length <= max) return str // UTF-16 長度不超過 max，code point 數必然不超過
  return Array.from(str).slice(0, max).join('')
}
