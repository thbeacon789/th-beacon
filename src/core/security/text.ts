// 注意：本檔會被 Node 直接執行（type stripping）。
/** 截到 UTF-16 長度不超過 max（與 payload 驗證的 .length 單位一致），且不切斷 surrogate pair */
export function truncateToUtf16Length(str: string, max: number): string {
  if (str.length <= max) return str
  let out = ''
  for (const ch of str) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}
