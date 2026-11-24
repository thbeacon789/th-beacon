import { afterEach, describe, expect, it } from 'vitest'
import { judge } from '../../scripts/security/lib/judge.ts'
import { startServer, type FakeServer } from './helpers'

let server: FakeServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

const check = { status: 'warn', summary: 'x' }
const finding = (extra: Record<string, unknown>) => ({
  check: 'ports', severity: 'high', title: 't', recommendation: 'r', ...extra,
})

async function runJudge(findings: unknown[]) {
  server = await startServer(() => ({
    json: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ checks: { ports: check, updates: check, logins: check }, findings }) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }))
  return { r: await judge({}, 'vm', { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: server.url }), req: server.requests[0] }
}

describe('judge finding key', () => {
  it('模型回傳的 key 字串原樣送出（不驗格式）', async () => {
    const { r } = await runJudge([finding({ key: 'tcp/3306' }), finding({ key: 'whatever!' })])
    expect(r.judgment.findings.map((f) => f.key)).toEqual(['tcp/3306', 'whatever!'])
  })

  it('缺 key 或非字串時不帶該欄位', async () => {
    const { r } = await runJudge([finding({}), finding({ key: 5 })])
    for (const f of r.judgment.findings) expect(f).not.toHaveProperty('key')
  })

  it('schema 要求 key，prompt 說明同 key 合併', async () => {
    const { req } = await runJudge([])
    const body = JSON.parse(req.body)
    const item = body.output_config.format.schema.properties.findings.items
    expect(item.required).toContain('key')
    expect(item.properties.key).toEqual({ type: 'string' })
    expect(body.system).toContain('同 key 合併成一筆')
    expect(body.system).toContain('tcp/<埠號>')
  })
})
