const PUBLIC_PREFIXES = [
  '/login',
  '/auth/callback',
  '/api/ingest',
  '/api/poll',
  '/api/heartbeat',
]

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
