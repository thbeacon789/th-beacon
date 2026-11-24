// 注意：本目錄會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。
import { FALLBACK_KEY } from './constants.ts'
import type { Finding, JudgedCheckKey } from './types.ts'

const PORT_RE = /^(tcp|udp)\/([1-9]\d{0,4})$/
const UPDATES_KEYS = new Set(['security', 'eol', 'reboot', 'auto-disabled'])
const LOGINS_KEYS = new Set(['password-auth', 'root-login', 'failed-spike'])
const UNEXPECTED_PREFIX = 'unexpected-success:'
const IP_RE = /^[0-9A-Fa-f:.]{1,45}$/
const isUnexpected = (s: string) => {
  if (!s.startsWith(UNEXPECTED_PREFIX)) return false
  const ip = s.slice(UNEXPECTED_PREFIX.length)
  return IP_RE.test(ip) && /\d/.test(ip)
}

function isValid(check: JudgedCheckKey, s: string): boolean {
  switch (check) {
    case 'ports': {
      const m = PORT_RE.exec(s)
      if (!m) return false
      const port = Number(m[2])
      return port >= 1 && port <= 65535
    }
    case 'updates':
      return UPDATES_KEYS.has(s)
    case 'logins':
      return LOGINS_KEYS.has(s) || isUnexpected(s)
  }
}

/** LLM 產出的 key 由 beacon 驗證；不合法一律退回 FALLBACK_KEY */
export function normalizeJudgedKey(check: JudgedCheckKey, raw: unknown): { key: string; keyFallback: boolean } {
  if (typeof raw === 'string' && isValid(check, raw)) return { key: raw, keyFallback: false }
  return { key: FALLBACK_KEY, keyFallback: true }
}

export function fingerprintOf(f: Pick<Finding, 'check' | 'key'>): string {
  return `${f.check}:${f.key}`
}
