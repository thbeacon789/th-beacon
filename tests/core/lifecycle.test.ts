import { describe, it, expect } from 'vitest'
import {
  allowedFrom,
  actorLabel,
  displayActor,
  encodeButtonId,
  parseButtonId,
} from '@/core/lifecycle'

const uuid = '123e4567-e89b-42d3-a456-426614174000'

describe('button custom_id', () => {
  it('encode/parse 來回一致且長度 ≤ 100', () => {
    const id = encodeButtonId('ack', uuid, 3)
    expect(id).toBe(`ack:${uuid}:3`)
    expect(id.length).toBeLessThanOrEqual(100)
    expect(parseButtonId(id)).toEqual({ action: 'ack', issueId: uuid, incidentSeq: 3 })
    expect(parseButtonId(encodeButtonId('resolve', uuid, 0))).toEqual({
      action: 'resolve',
      issueId: uuid,
      incidentSeq: 0,
    })
  })

  it.each([
    'ack:not-uuid:1',
    `nuke:${uuid}:1`,
    `ack:${uuid}:-1`,
    `ack:${uuid}`,
    `ack:${uuid}:1.5`,
    `ack:${uuid}:1:2`,
  ])('非法 %s 回 null', (id) => {
    expect(parseButtonId(id)).toBeNull()
  })
})

describe('allowedFrom', () => {
  it('各目標狀態的合法來源', () => {
    expect(allowedFrom('acknowledged')).toEqual(['open'])
    expect(allowedFrom('resolved')).toEqual(['open', 'acknowledged'])
    expect(allowedFrom('ignored')).toEqual(['open', 'acknowledged', 'resolved'])
    expect(allowedFrom('open')).toEqual(['acknowledged', 'resolved', 'ignored'])
  })
})

describe('actor', () => {
  it('actorLabel', () => {
    expect(actorLabel({ kind: 'system', source: 'poll' })).toBeNull()
    expect(actorLabel({ kind: 'discord', userId: '123' })).toBe('discord:123')
    expect(actorLabel({ kind: 'dashboard', email: 'a@b.c' })).toBe('a@b.c')
  })
  it('displayActor', () => {
    expect(displayActor('discord:123')).toBe('<@123>')
    expect(displayActor('a@b.c')).toBe('a@b.c')
  })
})
