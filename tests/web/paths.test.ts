import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { isPublicPath } from '@/web/paths'

describe('isPublicPath', () => {
  it('login and self-authenticating APIs are public', () => {
    for (const p of ['/login', '/auth/callback', '/api/ingest', '/api/poll/services', '/api/heartbeat', '/api/ai-usage', '/api/ai-fix', '/api/security-scan', '/api/report/weekly', '/api/discord/interactions']) {
      expect(isPublicPath(p)).toBe(true)
    }
  })
  it('dashboard pages are protected', () => {
    for (const p of ['/', '/issues', '/issues/abc', '/auth/signout']) {
      expect(isPublicPath(p)).toBe(false)
    }
  })
  it('does not treat prefix-lookalikes as public', () => {
    for (const p of ['/api/ingest2', '/api/pollx', '/loginx', '/api/discord', '/api/discord/interactionsx', '/api/ai-usagex', '/api/ai-fixx', '/api/security-scanx', '/api/report', '/api/report/weeklyx']) {
      expect(isPublicPath(p)).toBe(false)
    }
  })

  // 防再犯：新增 app/api/**/route.ts 時，必須在 PUBLIC_PREFIXES（自行驗簽）或下方「需登入」白名單二選一，
  // 否則 proxy 會把 CI／外部呼叫重導到 /login（handler 測試繞過 proxy，抓不到這種線上靜默失效）。
  it('每個 API 路由不是 public path，就是明確列在「需登入」白名單', () => {
    const LOGIN_REQUIRED_API: string[] = []
    const root = path.resolve(__dirname, '../../app/api')
    const routes: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name === 'route.ts') routes.push('/api/' + path.relative(root, path.dirname(full)).split(path.sep).join('/'))
      }
    }
    walk(root)
    expect(routes.length).toBeGreaterThan(0)
    const unlisted = routes.filter((r) => !isPublicPath(r) && !LOGIN_REQUIRED_API.includes(r))
    expect(unlisted).toEqual([])
  })
})
