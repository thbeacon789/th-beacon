import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { AI_TRIAGE_MODEL } from '@/core/ai-triage'
import { createClaudeTriager } from '@/triage/claude'

const PROMPT = { system: 'sys', user: 'usr' }

function messageBody(over: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: AI_TRIAGE_MODEL,
    content: [
      { type: 'text', text: JSON.stringify({ category: 'app', severity: 'P1', reason: '原因', suggestion: '建議' }) },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 123, output_tokens: 45 },
    ...over,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function setup(handler: (body: Record<string, unknown>) => Response | Promise<Response>, timeoutMs?: number) {
  const bodies: Record<string, unknown>[] = []
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    return handler(body)
  }) as typeof fetch
  const client = new Anthropic({ apiKey: 'test', fetch: fakeFetch, maxRetries: 0 })
  return { triage: createClaudeTriager(client, timeoutMs === undefined ? {} : { timeoutMs }), bodies }
}

describe('createClaudeTriager', () => {
  it('請求帶 json_schema structured output、固定 model，且不帶取樣參數', async () => {
    const { triage, bodies } = setup(() => jsonResponse(messageBody()))
    await triage(PROMPT)
    const b = bodies[0]!
    expect((b.output_config as { format: { type: string } }).format.type).toBe('json_schema')
    expect(b.model).toBe('claude-sonnet-5-5')
    expect(b.max_tokens).toBe(1024)
    expect(b.system).toBe('sys')
    expect(b.messages).toEqual([{ role: 'user', content: 'usr' }])
    for (const k of ['temperature', 'top_p', 'top_k']) expect(b).not.toHaveProperty(k)
  })

  it('正常回應 → ok:true，diagnosis 與 usage 正確，並 log usage', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { triage } = setup(() => jsonResponse(messageBody()))
    const r = await triage(PROMPT)
    expect(r).toEqual({
      ok: true,
      diagnosis: { category: 'app', severity: 'P1', reason: '原因', suggestion: '建議', model: AI_TRIAGE_MODEL },
      usage: { inputTokens: 123, outputTokens: 45 },
    })
    expect(log).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })

  it.each(['refusal', 'max_tokens'])('stop_reason %s → ok:false', async (stop) => {
    const { triage } = setup(() => jsonResponse(messageBody({ stop_reason: stop })))
    const r = await triage(PROMPT)
    expect(r.ok).toBe(false)
  })

  it('text 非 JSON → ok:false', async () => {
    const { triage } = setup(() => jsonResponse(messageBody({ content: [{ type: 'text', text: 'not json' }] })))
    expect((await triage(PROMPT)).ok).toBe(false)
  })

  it('JSON 但欄位不合 schema → ok:false', async () => {
    const { triage } = setup(() =>
      jsonResponse(messageBody({ content: [{ type: 'text', text: '{"severity":"P9"}' }] })),
    )
    expect((await triage(PROMPT)).ok).toBe(false)
  })

  it('HTTP 401 → ok:false，錯誤不含 sk-ant／Bearer', async () => {
    const { triage } = setup(() =>
      jsonResponse(
        { type: 'error', error: { type: 'authentication_error', message: 'bad key sk-ant-secret Bearer abc' } },
        401,
      ),
    )
    const r = await triage(PROMPT)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).not.toMatch(/sk-ant|Bearer/)
      expect(r.error).toContain('401')
      expect(r.error.length).toBeLessThanOrEqual(200)
    }
  })

  it('錯誤訊息含 JWT → ok:false，error 不含 eyJ', async () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lcjp0ZWFtIn0.c2lnbmF0dXJl'
    const { triage } = setup(() =>
      jsonResponse({ type: 'error', error: { type: 'authentication_error', message: `bad token ${jwt}` } }, 401),
    )
    const r = await triage(PROMPT)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toContain('eyJ')
  })

  it('逾時 → ok:false', async () => {
    const { triage } = setup(
      () => new Promise<Response>(() => {}),
      50,
    )
    const r = await triage(PROMPT)
    expect(r.ok).toBe(false)
  })
})
