import { describe, it, expect, vi } from 'vitest'

// runHeartbeatScan 內部雖然對每筆心跳做了 try/catch，但它開頭的
// store.listEnabledHeartbeats() 這次呼叫不在保護範圍內。修法：cron route 要把
// 心跳掃描單獨包一層 try/catch，失敗時回應改帶 heartbeatsError，而非讓已經
// 成功跑完的 runPoll 結果也一起變成 500（Hobby cron 一天一次，500 等於整天
// 都沒有可查的 poll 結果）。這裡整段 mock 掉 DB / poll / heartbeat 依賴，
// 純粹驗證 route 層的例外隔離邏輯，不需要真的連線。
vi.mock('@/store/server', () => ({
  createServerStore: () => ({}),
  createServerNotifyDeps: () => ({ sender: async () => ({ ok: true }), fallbackWebhookUrl: null }),
  getCronSecret: () => 'test-cron-secret',
}))
vi.mock('@/poll/http', () => ({ httpGet: async () => ({ ok: true, status: 200 }) }))

const pollOutcomes = [{ serviceId: 's-1', healthy: true }]

function cronRequest(): Request {
  return new Request('http://localhost/api/poll/services', {
    headers: { authorization: 'Bearer test-cron-secret' },
  })
}

describe('GET /api/poll/services — 心跳掃描例外隔離', () => {
  it('runHeartbeatScan 拋錯時，仍回 200 並保留已完成的 poll 結果，另帶 heartbeatsError', async () => {
    vi.resetModules()
    vi.doMock('@/poll/poll-service', () => ({ runPoll: async () => pollOutcomes }))
    vi.doMock('@/heartbeat/scan', () => ({
      runHeartbeatScan: async () => {
        throw new Error('listEnabledHeartbeats failed: boom')
      },
    }))
    const { GET } = await import('@/../app/api/poll/services/route')

    const res = await GET(cronRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.polled).toBe(1)
    expect(body.outcomes).toEqual(pollOutcomes)
    expect(body.heartbeatsOverdue).toBe(0)
    expect(body.heartbeats).toEqual([])
    expect(body.heartbeatsError).toContain('listEnabledHeartbeats failed')
  })

  it('runPoll 拋錯時仍回 500（既有行為不變）', async () => {
    vi.resetModules()
    vi.doMock('@/poll/poll-service', () => ({
      runPoll: async () => {
        throw new Error('poll boom')
      },
    }))
    vi.doMock('@/heartbeat/scan', () => ({ runHeartbeatScan: async () => [] }))
    const { GET } = await import('@/../app/api/poll/services/route')

    const res = await GET(cronRequest())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('poll boom')
  })
})
