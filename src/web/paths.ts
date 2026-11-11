const PUBLIC_PREFIXES = [
  '/login',
  '/auth/callback',
  '/api/ingest',
  '/api/poll',
  '/api/heartbeat',
  // Discord 按鈕回呼：以 Ed25519 簽章自行驗證
  '/api/discord/interactions',
]

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
