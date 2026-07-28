const PUBLIC_PREFIXES = ['/login', '/api/ingest', '/api/poll']

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
