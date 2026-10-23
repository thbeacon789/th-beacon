import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyIngestSignature } from '@/ingest/hmac'
import { runBash, startServer, type FakeServer } from './helpers'

const SCRIPT = path.resolve(__dirname, '../../scripts/heartbeat-to-beacon.sh')

describe('heartbeat-to-beacon.sh', () => {
  let dir: string
  let server: FakeServer

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'))
    server = await startServer(() => ({ json: { ok: true } }))
  })
  afterEach(async () => {
    await server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const env = () => ({
    BEACON_URL: `${server.url}/api/heartbeat`,
    BEACON_SERVICE: 'svc',
    BEACON_SECRET: 'topsecret',
  })
  const body = () => JSON.parse(server.requests[0].body) as Record<string, unknown>

  it('第 5 參數為 diagnosis 檔時 payload 含 diagnosis', async () => {
    const diag = { category: 'env', severity: 'P2', reason: 'r', suggestion: 's', model: 'm' }
    const f = path.join(dir, 'd.json')
    fs.writeFileSync(f, JSON.stringify(diag))
    const r = await runBash(SCRIPT, ['daily', 'fail', 'http://run', 'sum', f], env())
    expect(r.code).toBe(0)
    expect(body().diagnosis).toEqual(diag)
    expect(body().diagnosisError).toBeUndefined()
  })

  it('第 5 參數為 error 檔時 payload 含 diagnosisError', async () => {
    const f = path.join(dir, 'e.json')
    fs.writeFileSync(f, JSON.stringify({ error: 'wif exchange failed: 401' }))
    const r = await runBash(SCRIPT, ['daily', 'fail', 'http://run', 'sum', f], env())
    expect(r.code).toBe(0)
    expect(body().diagnosisError).toBe('wif exchange failed: 401')
    expect(body().diagnosis).toBeUndefined()
  })

  it('第 5 參數缺省或檔案不存在時 payload 與舊版相同', async () => {
    await runBash(SCRIPT, ['daily', 'fail', 'http://run', 'sum'], env())
    await runBash(SCRIPT, ['daily', 'fail', 'http://run', 'sum', path.join(dir, 'nope.json')], env())
    const junk = path.join(dir, 'junk.json')
    fs.writeFileSync(junk, 'not json{')
    await runBash(SCRIPT, ['daily', 'fail', 'http://run', 'sum', junk], env())
    expect(server.requests).toHaveLength(3)
    for (const r of server.requests) {
      expect(JSON.parse(r.body)).toEqual({ name: 'daily', status: 'fail', runUrl: 'http://run', summary: 'sum' })
    }
  })

  it('簽章仍可被 verifyIngestSignature 驗過', async () => {
    const f = path.join(dir, 'd.json')
    fs.writeFileSync(f, JSON.stringify({ category: 'app', severity: 'P0', reason: '理由', suggestion: 's' }))
    await runBash(SCRIPT, ['daily', 'fail', 'http://run', '摘要', f], env())
    const req = server.requests[0]
    const res = verifyIngestSignature({
      secret: 'topsecret',
      rawBody: req.body,
      timestamp: String(req.headers['x-beacon-timestamp']),
      signature: String(req.headers['x-beacon-signature']),
      now: new Date(),
    })
    expect(res).toEqual({ ok: true })
  })
})
