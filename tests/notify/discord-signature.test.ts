import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { verifyDiscordSignature } from '@/notify/discord-signature'

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const x = publicKey.export({ format: 'jwk' }).x as string
  return { privateKey, publicKeyHex: Buffer.from(x, 'base64url').toString('hex') }
}

describe('verifyDiscordSignature', () => {
  it('正確簽章回 true', () => {
    const { privateKey, publicKeyHex } = makeKey()
    const sig = sign(null, Buffer.from('1700000000{"type":1}'), privateKey).toString('hex')
    expect(verifyDiscordSignature(publicKeyHex, sig, '1700000000', '{"type":1}')).toBe(true)
  })

  it('body 被改一個字元回 false', () => {
    const { privateKey, publicKeyHex } = makeKey()
    const sig = sign(null, Buffer.from('1700000000{"type":1}'), privateKey).toString('hex')
    expect(verifyDiscordSignature(publicKeyHex, sig, '1700000000', '{"type":2}')).toBe(false)
  })

  it('非 hex 公鑰回 false 且不 throw', () => {
    expect(verifyDiscordSignature('not-hex!!', 'zz', 't', 'b')).toBe(false)
    expect(verifyDiscordSignature('', '', 't', 'b')).toBe(false)
  })
})
