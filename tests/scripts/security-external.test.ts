import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeDomain } from '../../scripts/security/lib/external.ts'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
let server: http.Server | undefined

async function start(handler: Handler): Promise<string> {
  server = http.createServer(handler)
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(async () => {
  server?.closeAllConnections?.()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = undefined
})

const PATHS = [{ path: '/.env', signature: '(?m)^[A-Z][A-Z0-9_]{2,}=.+' }]
const exposedOf = (r: { sensitivePaths: Array<{ path: string; exposed: boolean }> }, p: string) =>
  r.sensitivePaths.find((x) => x.path === p)?.exposed

describe('probeDomain', () => {
  it('200 且內容符合特徵才算暴露', async () => {
    const baseUrl = await start((req, res) => {
      res.statusCode = 200
      res.end(req.url === '/.env' ? 'APP_NAME=x\nDB_PASSWORD=x\n' : 'home')
    })
    const r = await probeDomain('app.example.test', PATHS, { baseUrl })
    expect(exposedOf(r, '/.env')).toBe(true)
    expect(r.domain).toBe('app.example.test')
  })

  it('SPA 對任何路徑回 200 HTML 不算暴露', async () => {
    const baseUrl = await start((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><html><body>app</body></html>')
    })
    const r = await probeDomain('app.example.test', PATHS, { baseUrl })
    expect(exposedOf(r, '/.env')).toBe(false)
  })

  it('404、轉址、逾時、連線錯誤皆不算暴露', async () => {
    const cases: Array<[string, Handler]> = [
      ['404', (req, res) => { res.statusCode = req.url === '/' ? 200 : 404; res.end('DB_PASSWORD=x') }],
      ['轉址', (req, res) => {
        if (req.url === '/') { res.end('home'); return }
        res.statusCode = 302; res.setHeader('location', '/'); res.end('DB_PASSWORD=x')
      }],
      ['逾時', (req, res) => { if (req.url === '/') res.end('home') }],
      ['連線錯誤', (req, res) => { if (req.url === '/') res.end('home'); else req.socket.destroy() }],
    ]
    for (const [name, handler] of cases) {
      const baseUrl = await start(handler)
      const r = await probeDomain('app.example.test', PATHS, { baseUrl, timeoutMs: 300 })
      expect(exposedOf(r, '/.env'), name).toBe(false)
      server!.closeAllConnections?.()
      await new Promise<void>((res) => server!.close(() => res()))
      server = undefined
    }
  })

  it('單一路徑連線被重置：exposed 仍為 false，probeErrors 為 1；404 不算失敗', async () => {
    const baseUrl = await start((req, res) => {
      if (req.url === '/') res.end('home')
      else if (req.url === '/.env') req.socket.destroy()
      else { res.statusCode = 404; res.end('nope') }
    })
    const paths = [...PATHS, { path: '/.git/config', signature: '^\\[core\\]' }]
    const r = await probeDomain('app.example.test', paths, { baseUrl, timeoutMs: 300 })
    expect(r.probeErrors).toBe(1)
    expect(exposedOf(r, '/.env')).toBe(false)
    expect(exposedOf(r, '/.git/config')).toBe(false)
  })

  it('由回應標頭判定五個布林，CSP 的 frame-ancestors 算防嵌入', async () => {
    const baseUrl = await start((_req, res) => {
      res.setHeader('strict-transport-security', 'max-age=1')
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'")
      res.end('home')
    })
    const r = await probeDomain('app.example.test', [], { baseUrl })
    expect(r.headers).toEqual({
      hsts: true, contentTypeOptions: true, frameProtection: true, csp: true, referrerPolicy: false,
    })
  })

  it('domain 格式不符直接拒絕', async () => {
    await expect(probeDomain('a b/../x', [])).rejects.toThrow()
  })
})
