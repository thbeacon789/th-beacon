import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServerNotifyDeps } from '@/store/server'

const ALL = {
  DISCORD_BOT_TOKEN: 't',
  DISCORD_PUBLIC_KEY: 'k',
  DISCORD_APPLICATION_ID: 'a',
  DISCORD_ALERT_CHANNEL_ID: 'c',
}

function stub(env: Record<string, string>) {
  for (const name of Object.keys(ALL)) vi.stubEnv(name, '')
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
}

describe('createServerNotifyDeps bot 接線', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('四個變數齊全 -> bot 非 null', () => {
    stub(ALL)
    expect(createServerNotifyDeps().bot).not.toBeNull()
  })

  for (const missing of Object.keys(ALL)) {
    it(`缺 ${missing} -> bot 為 null`, () => {
      stub(Object.fromEntries(Object.entries(ALL).filter(([k]) => k !== missing)))
      expect(createServerNotifyDeps().bot).toBeNull()
    })
  }
})
