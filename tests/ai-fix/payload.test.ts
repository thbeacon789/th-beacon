import { describe, it, expect } from 'vitest'
import { parseAiFixPayload } from '@/ai-fix/payload'

const PR = 'https://github.com/o/r/pull/1'
const RUN = 'https://github.com/o/r/actions/runs/1'

describe('parseAiFixPayload', () => {
  it('pr_opened 合法 → value 含 heartbeat/status/prUrl/summary/runUrl', () => {
    const r = parseAiFixPayload({ heartbeat: 'e2e', status: 'pr_opened', prUrl: PR, summary: '已修', runUrl: RUN })
    expect(r).toEqual({
      ok: true,
      value: { heartbeat: 'e2e', status: 'pr_opened', prUrl: PR, summary: '已修', runUrl: RUN },
    })
  })

  it('no_fix 與 failed 不需要 prUrl；即使帶了 prUrl 也存成 null', () => {
    for (const status of ['no_fix', 'failed']) {
      const a = parseAiFixPayload({ heartbeat: 'e2e', status })
      expect(a).toEqual({
        ok: true,
        value: { heartbeat: 'e2e', status, prUrl: null, summary: null, runUrl: null },
      })
      const b = parseAiFixPayload({ heartbeat: 'e2e', status, prUrl: PR })
      expect(b.ok && b.value.prUrl).toBe(null)
    }
  })

  it('pr_opened 缺 prUrl → 錯誤', () => {
    expect(parseAiFixPayload({ heartbeat: 'e2e', status: 'pr_opened' }).ok).toBe(false)
  })

  it('pr_opened 且 prUrl 為 http://github.com.evil.com/o/r/pull/1 → 錯誤', () => {
    expect(
      parseAiFixPayload({ heartbeat: 'e2e', status: 'pr_opened', prUrl: 'http://github.com.evil.com/o/r/pull/1' }).ok,
    ).toBe(false)
  })

  it('status 非三值（含 "success"、undefined）→ 錯誤', () => {
    for (const status of ['success', undefined, 1]) {
      expect(parseAiFixPayload({ heartbeat: 'e2e', status }).ok).toBe(false)
    }
  })

  it('heartbeat 缺漏／空白字串／非字串 → 錯誤', () => {
    for (const heartbeat of [undefined, '', '   ', 5]) {
      expect(parseAiFixPayload({ heartbeat, status: 'no_fix' }).ok).toBe(false)
    }
  })

  it('summary 超過 500 字 → 截斷為 500 字（結尾 …）；空字串 → null', () => {
    const r = parseAiFixPayload({ heartbeat: 'e2e', status: 'failed', summary: 'a'.repeat(600) })
    expect(r.ok && r.value.summary).toBe(`${'a'.repeat(499)}…`)
    const e = parseAiFixPayload({ heartbeat: 'e2e', status: 'failed', summary: '' })
    expect(e.ok && e.value.summary).toBe(null)
  })

  it('runUrl 不合白名單（javascript:、含空白或 `)`）→ 丟棄為 null，不報錯', () => {
    for (const runUrl of ['javascript:alert(1)', `${RUN} x`, `${RUN})`]) {
      const r = parseAiFixPayload({ heartbeat: 'e2e', status: 'no_fix', runUrl })
      expect(r.ok && r.value.runUrl).toBe(null)
    }
  })

  it('payload 非物件（陣列、null）→ 錯誤', () => {
    for (const bad of [[], null, 'x', undefined]) {
      expect(parseAiFixPayload(bad).ok).toBe(false)
    }
  })
})
