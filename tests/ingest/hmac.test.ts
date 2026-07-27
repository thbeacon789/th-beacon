import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyIngestSignature } from '@/ingest/hmac'

const secret = 'test-secret'
const body = '{"message":"boom"}'
const now = new Date('2026-07-28T10:00:00.000Z')
const nowSec = Math.floor(now.getTime() / 1000)

function sign(sec: string, ts: string, raw: string): string {
  return `sha256=${createHmac('sha256', sec).update(`${ts}.${raw}`).digest('hex')}`
}

describe('verifyIngestSignature', () => {
  it('accepts a valid signature within tolerance', () => {
    const ts = String(nowSec)
    expect(
      verifyIngestSignature({ secret, rawBody: body, timestamp: ts, signature: sign(secret, ts, body), now }),
    ).toEqual({ ok: true })
  })

  it('accepts exactly at the tolerance boundary (300s)', () => {
    const ts = String(nowSec - 300)
    expect(
      verifyIngestSignature({ secret, rawBody: body, timestamp: ts, signature: sign(secret, ts, body), now }).ok,
    ).toBe(true)
  })

  it('rejects beyond tolerance (301s, both directions)', () => {
    for (const ts of [String(nowSec - 301), String(nowSec + 301)]) {
      expect(
        verifyIngestSignature({ secret, rawBody: body, timestamp: ts, signature: sign(secret, ts, body), now }),
      ).toEqual({ ok: false, reason: 'timestamp_skew' })
    }
  })

  it('rejects non-numeric timestamp', () => {
    expect(
      verifyIngestSignature({ secret, rawBody: body, timestamp: 'abc', signature: 'sha256=' + '0'.repeat(64), now }),
    ).toEqual({ ok: false, reason: 'timestamp_format' })
  })

  it('rejects malformed signature header', () => {
    const ts = String(nowSec)
    for (const bad of ['deadbeef', 'sha256=zz', 'sha1=' + '0'.repeat(64), 'sha256=' + '0'.repeat(63)]) {
      expect(
        verifyIngestSignature({ secret, rawBody: body, timestamp: ts, signature: bad, now }),
      ).toEqual({ ok: false, reason: 'signature_format' })
    }
  })

  it('rejects tampered body and wrong secret', () => {
    const ts = String(nowSec)
    expect(
      verifyIngestSignature({ secret, rawBody: body + ' ', timestamp: ts, signature: sign(secret, ts, body), now }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' })
    expect(
      verifyIngestSignature({ secret: 'other', rawBody: body, timestamp: ts, signature: sign(secret, ts, body), now }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('binds the timestamp into the signature (moving ts invalidates)', () => {
    const ts = String(nowSec)
    const other = String(nowSec - 10)
    expect(
      verifyIngestSignature({ secret, rawBody: body, timestamp: other, signature: sign(secret, ts, body), now }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' })
  })
})
