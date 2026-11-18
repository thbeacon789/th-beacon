import { describe, it, expect } from 'vitest'
import { summarizeLogins } from '@/core/security/collect/logins'

const lines = [
  '2026-11-18T02:13:44+0000 host sshd[1234]: Failed password for invalid user admin from 203.0.113.9 port 51234 ssh2',
  '2026-11-18T02:13:50+0000 host sshd[1235]: Failed password for root from 203.0.113.9 port 51240 ssh2',
  '2026-11-18T02:14:01+0000 host sshd[1236]: Invalid user test from 198.51.100.7 port 40022',
  '2026-11-18T03:00:12+0000 host sshd[1300]: Accepted publickey for deploy from 192.0.2.10 port 50122 ssh2: ED25519 SHA256:abc',
  'not a log line',
]

describe('summarizeLogins', () => {
  it('計數失敗、排名來源 IP、列出成功登入', () => {
    const s = summarizeLogins(lines)
    expect(s.failed).toBe(3)
    expect(s.topSources).toEqual([{ ip: '203.0.113.9', count: 2 }, { ip: '198.51.100.7', count: 1 }])
    expect(s.topUsers[0]).toEqual({ user: 'admin', count: 1 })
    expect(s.topUsers).toHaveLength(3)
    expect(s.accepted).toEqual([{ user: 'deploy', ip: '192.0.2.10', method: 'publickey', at: '2026-11-18T03:00:12+0000' }])
  })

  it('同一行同時符合兩種樣式只算一次失敗', () => {
    const s = summarizeLogins(['t h sshd[1]: Failed password for invalid user x from 1.2.3.4 port 1 ssh2 Invalid user x from 1.2.3.4 port 1'])
    expect(s.failed).toBe(1)
  })

  it('使用者名稱截斷至 64 字元；top 各取前 10', () => {
    const long = 'u'.repeat(100)
    const many = Array.from({ length: 15 }, (_, i) => `t h sshd[1]: Invalid user ${long}${i} from 10.0.0.${i} port 1`)
    const s = summarizeLogins(many)
    expect(s.failed).toBe(15)
    expect(s.topSources).toHaveLength(10)
    expect(s.topUsers.every((u) => u.user.length <= 64)).toBe(true)
    expect(s.topUsers).toHaveLength(1)
    expect(s.topUsers[0].count).toBe(15)
  })

  it('使用者名稱夾帶假的 from 時，來源取最後一個真正的位置', () => {
    const s = summarizeLogins(['t h sshd[1]: Invalid user x from 9.9.9.9 from 1.1.1.1 port 22'])
    expect(s.topSources).toEqual([{ ip: '1.1.1.1', count: 1 }])
  })

  it('特殊名稱（__proto__）不造成問題，空輸入回零值', () => {
    const s = summarizeLogins(['t h sshd[1]: Invalid user __proto__ from 1.1.1.1 port 22'])
    expect(s.topUsers).toEqual([{ user: '__proto__', count: 1 }])
    expect(summarizeLogins([])).toEqual({ failed: 0, topSources: [], topUsers: [], accepted: [] })
  })

  it('非 IP 的來源略過', () => {
    expect(summarizeLogins(['t h sshd[1]: Invalid user x from <script> port 22']).failed).toBe(0)
  })
})
