import { verify } from 'node:crypto'

// Ed25519 公鑰（32 byte raw）包成 SPKI DER 的固定前綴
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** 驗證 Discord Interactions 簽章；任何解析錯誤一律回 false。 */
export function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  rawBody: string,
): boolean {
  try {
    if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]+$/i.test(signatureHex)) return false
    const key = Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')])
    return verify(
      null,
      Buffer.from(timestamp + rawBody),
      { key, format: 'der', type: 'spki' },
      Buffer.from(signatureHex, 'hex'),
    )
  } catch {
    return false
  }
}
