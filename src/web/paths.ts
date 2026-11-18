const PUBLIC_PREFIXES = [
  '/login',
  '/auth/callback',
  '/api/ingest',
  '/api/poll',
  '/api/heartbeat',
  '/api/ai-usage',
  // CI 回報 AI 修復結果：HMAC 自行驗簽
  '/api/ai-fix',
  // 資安掃描快照：HMAC 自行驗簽
  '/api/security-scan',
  // Discord 按鈕回呼：以 Ed25519 簽章自行驗證
  '/api/discord/interactions',
]

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
