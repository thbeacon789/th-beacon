// 注意：本檔會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。
// 輸入為不可信資料（使用者名稱由攻擊者決定）：只用固定樣式比對，不以輸入內容組 pattern。

export interface LoginSummary {
  failed: number
  topSources: Array<{ ip: string; count: number }>
  topUsers: Array<{ user: string; count: number }>
  accepted: Array<{ user: string; ip: string; method: string; at: string }>
}

const TOP_N = 10
const MAX_USER = 64
const LINE_RE = /^(\S+)\s+\S+\s+sshd(?:-session)?\[\d+\]:\s+(.*)$/
// 使用者名稱可含空白與 "from"，故用貪婪比對取最後一組「from <ip> port <n>」
const FAILED_RE = /^Failed password for (?:invalid user )?(.+) from (\S+) port \d+/
const INVALID_RE = /^Invalid user (.+) from (\S+) port \d+/
const ACCEPTED_RE = /^Accepted (\S+) for (.+) from (\S+) port \d+/
// 連線在認證前被關閉：與同一連線的 Invalid user 行可能重複計入失敗，可接受（寧可多報）
const CLOSED_RE = /^Connection closed by (?:authenticating|invalid) user (.+) (\S+) port \d+/
const IP_RE = /^[0-9a-fA-F:.]{2,45}$/

function top<T extends string>(m: Map<string, number>, key: T): Array<Record<T, string> & { count: number }> {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([k, count]) => ({ [key]: k, count }) as Record<T, string> & { count: number })
}

export function summarizeLogins(authLines: string[]): LoginSummary {
  let failed = 0
  const sources = new Map<string, number>()
  const users = new Map<string, number>()
  const accepted: LoginSummary['accepted'] = []

  for (const line of authLines) {
    const head = LINE_RE.exec(line)
    if (!head) continue
    const [, at, msg] = head
    const fail = FAILED_RE.exec(msg) ?? INVALID_RE.exec(msg) ?? CLOSED_RE.exec(msg)
    if (fail) {
      const ip = fail[2]
      const user = fail[1].slice(0, MAX_USER)
      // 來源不是合法 IP 格式的失敗仍要計入 failed（不可因格式怪異而少報），只是不進 topSources
      failed += 1
      if (IP_RE.test(ip)) sources.set(ip, (sources.get(ip) ?? 0) + 1)
      users.set(user, (users.get(user) ?? 0) + 1)
      continue
    }
    const ok = ACCEPTED_RE.exec(msg)
    if (ok && IP_RE.test(ok[3])) {
      accepted.push({ user: ok[2].slice(0, MAX_USER), ip: ok[3], method: ok[1], at: at.slice(0, 40) })
    }
  }
  return { failed, topSources: top(sources, 'ip'), topUsers: top(users, 'user'), accepted }
}

/**
 * 掃描器自己每天登入 VM，會出現在 accepted 裡：把屬於 ignoreUsers 的項目移除，
 * 並回報移除的筆數，讓判讀知道有預期內的登入被濾掉。
 */
export function filterScannerLogins(
  summary: LoginSummary,
  ignoreUsers: string[] | undefined,
): { summary: LoginSummary; ignoredScannerLogins: number } {
  const ignore = new Set(ignoreUsers ?? [])
  if (ignore.size === 0) return { summary, ignoredScannerLogins: 0 }
  const accepted = summary.accepted.filter((a) => !ignore.has(a.user))
  return { summary: { ...summary, accepted }, ignoredScannerLogins: summary.accepted.length - accepted.length }
}
