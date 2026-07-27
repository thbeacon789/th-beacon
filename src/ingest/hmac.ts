import { createHmac, timingSafeEqual } from 'node:crypto'

export interface VerifyArgs {
  secret: string
  rawBody: string
  timestamp: string
  signature: string
  now: Date
  toleranceSeconds?: number
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'timestamp_format' | 'timestamp_skew' | 'signature_format' | 'signature_mismatch' }

export function verifyIngestSignature(args: VerifyArgs): VerifyResult {
  const tolerance = args.toleranceSeconds ?? 300

  if (!/^\d+$/.test(args.timestamp)) return { ok: false, reason: 'timestamp_format' }
  const skewSeconds = Math.abs(args.now.getTime() / 1000 - Number(args.timestamp))
  if (skewSeconds > tolerance) return { ok: false, reason: 'timestamp_skew' }

  const match = /^sha256=([0-9a-f]{64})$/.exec(args.signature)
  if (match === null) return { ok: false, reason: 'signature_format' }

  const expected = createHmac('sha256', args.secret)
    .update(`${args.timestamp}.${args.rawBody}`)
    .digest()
  const provided = Buffer.from(match[1], 'hex')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature_mismatch' }
  }
  return { ok: true }
}
