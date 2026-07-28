import { describe, it, expect } from 'vitest'
import { parseHeartbeatPayload } from '@/heartbeat/payload'

describe('parseHeartbeatPayload', () => {
  it('接受最小合法 payload', () => {
    const result = parseHeartbeatPayload({ name: 'daily-test', status: 'pass' })
    expect(result).toEqual({ ok: true, value: { name: 'daily-test', status: 'pass' }, warnings: [] })
  })

  it('保留選填欄位', () => {
    const result = parseHeartbeatPayload({
      name: 'daily-test',
      status: 'fail',
      runUrl: 'https://ci/run/1',
      summary: '3 failed',
    })
    expect(result).toEqual({
      ok: true,
      value: { name: 'daily-test', status: 'fail', runUrl: 'https://ci/run/1', summary: '3 failed' },
      warnings: [],
    })
  })

  it('拒絕非物件', () => {
    expect(parseHeartbeatPayload([]).ok).toBe(false)
    expect(parseHeartbeatPayload(null).ok).toBe(false)
    expect(parseHeartbeatPayload('x').ok).toBe(false)
  })

  it('name 必填且非空', () => {
    const result = parseHeartbeatPayload({ status: 'pass' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toContain('name')
  })

  it('status 只接受 pass 或 fail', () => {
    const result = parseHeartbeatPayload({ name: 'x', status: 'ok' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toContain('status')
  })

  it('選填欄位型別錯誤時拒絕', () => {
    const result = parseHeartbeatPayload({ name: 'x', status: 'pass', runUrl: 42 })
    expect(result.ok).toBe(false)
  })

  it('runUrl 非 http(s) scheme 時濾掉並回 warning，但不拒收整包（避免存活訊號送不出去）', () => {
    const result = parseHeartbeatPayload({ name: 'x', status: 'pass', runUrl: 'javascript:alert(1)' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ name: 'x', status: 'pass' })
      expect(result.value.runUrl).toBeUndefined()
      expect(result.warnings.join()).toContain('runUrl')
    }
  })
})
