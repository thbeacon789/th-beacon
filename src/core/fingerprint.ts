import { createHash } from 'node:crypto'

export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function computeFingerprint(input: {
  serviceId: string
  errorType: string
  message: string
}): string {
  const normalized = normalizeMessage(input.message)
  return createHash('sha256')
    .update(`${input.serviceId}\n${input.errorType}\n${normalized}`)
    .digest('hex')
}
