import { spawn } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Recorded {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: string
}

export type Handler = (req: Recorded) => { status?: number; json?: unknown; raw?: string }

export interface FakeServer {
  url: string
  requests: Recorded[]
  close: () => Promise<void>
}

export async function startServer(handler: Handler): Promise<FakeServer> {
  const requests: Recorded[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rec: Recorded = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(rec)
      const out = handler(rec)
      res.statusCode = out.status ?? 200
      res.setHeader('content-type', 'application/json')
      res.end(out.raw ?? JSON.stringify(out.json ?? {}))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** 乾淨 env（不洩漏開發者本機的 ANTHROPIC_*），非同步執行以免擋住同進程的假 server。 */
export function runBash(script: string, args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', [script, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
