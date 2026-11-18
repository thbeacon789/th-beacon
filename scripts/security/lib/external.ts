// 注意：本檔以 Node 直接執行（type stripping）。只用相對路徑加 .ts 副檔名與 Node 內建模組。
// 對外探測只針對目標設定 domains 列出的主機；回應內容一律視為不可信資料，只做固定樣式比對。
import tls from 'node:tls'
import type { CertFact, ExposureFact } from '../../../src/core/security/types.ts'

export interface ExposurePath { path: string; signature: string }

const DOMAIN_RE = /^[a-z0-9.-]+$/i
const USER_AGENT = 'security-scan/1.0'
const MAX_BODY = 64 * 1024

export const isValidDomain = (d: string): boolean => DOMAIN_RE.test(d)

function assertDomain(domain: string): void {
  if (!isValidDomain(domain)) throw new Error('domain 格式不符')
}

/** signature 來自版控設定；JS 不支援 (?m) 行內旗標，開頭帶 (?m) 時改用 m 旗標。 */
function compileSignature(signature: string): RegExp {
  return signature.startsWith('(?m)') ? new RegExp(signature.slice(4), 'm') : new RegExp(signature)
}

async function readHead(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < MAX_BODY) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).subarray(0, MAX_BODY).toString('utf8')
}

export async function probeDomain(
  domain: string,
  paths: ExposurePath[],
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<Omit<ExposureFact, 'legacyTls'>> {
  assertDomain(domain)
  const base = (opts.baseUrl ?? `https://${domain}`).replace(/\/+$/, '')
  const timeoutMs = opts.timeoutMs ?? 10_000
  const headers = { 'user-agent': USER_AGENT }

  // 首頁：唯一允許跟隨轉址的請求；失敗就整個 domain 放棄（由呼叫端略過）
  const home = await fetch(`${base}/`, {
    method: 'GET', redirect: 'follow', headers, signal: AbortSignal.timeout(timeoutMs),
  })
  await home.body?.cancel().catch(() => {})
  const h = home.headers
  const csp = h.get('content-security-policy')
  const result: Omit<ExposureFact, 'legacyTls'> = {
    domain,
    sensitivePaths: [],
    headers: {
      hsts: h.has('strict-transport-security'),
      contentTypeOptions: h.has('x-content-type-options'),
      frameProtection: h.has('x-frame-options') || (csp !== null && /frame-ancestors/i.test(csp)),
      csp: csp !== null,
      referrerPolicy: h.has('referrer-policy'),
    },
  }

  for (const p of paths) {
    let exposed = false
    try {
      const res = await fetch(`${base}${p.path}`, {
        method: 'GET', redirect: 'manual', headers, signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 200) exposed = compileSignature(p.signature).test(await readHead(res))
      else await res.body?.cancel().catch(() => {})
    } catch {
      exposed = false
    }
    result.sensitivePaths.push({ path: p.path, exposed })
  }
  return result
}

export function fetchCert(domain: string, opts: { port?: number; timeoutMs?: number } = {}): Promise<CertFact> {
  return new Promise((resolve, reject) => {
    try {
      assertDomain(domain)
    } catch (e) {
      reject(e)
      return
    }
    const socket = tls.connect({ host: domain, port: opts.port ?? 443, servername: domain })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('取得憑證逾時'))
    }, opts.timeoutMs ?? 10_000)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      const cert = socket.getPeerCertificate()
      socket.end()
      const t = Date.parse(cert?.valid_to ?? '')
      if (Number.isNaN(t)) reject(new Error('憑證無有效期限'))
      else resolve({ domain, notAfter: new Date(t).toISOString() })
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`取得憑證失敗：${(err as NodeJS.ErrnoException).code ?? 'error'}`))
    })
  })
}

// 伺服器端明確拒絕舊版協定時才算 false；其餘一律 null（寧可不確定也不誤報「已停用」）
const SERVER_REJECT_CODES = new Set(['ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', 'ECONNRESET'])

export function probeLegacyTls(domain: string, opts: { port?: number; timeoutMs?: number } = {}): Promise<boolean | null> {
  return new Promise((resolve) => {
    if (!isValidDomain(domain)) {
      resolve(null)
      return
    }
    let settled = false
    const done = (v: boolean | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(v)
    }
    let socket: tls.TLSSocket
    const timer = setTimeout(() => done(null), opts.timeoutMs ?? 10_000)
    try {
      socket = tls.connect({
        host: domain,
        port: opts.port ?? 443,
        servername: domain,
        minVersion: 'TLSv1',
        maxVersion: 'TLSv1.1',
        ciphers: 'DEFAULT@SECLEVEL=0',
        rejectUnauthorized: false,
      })
    } catch {
      clearTimeout(timer)
      resolve(null)
      return
    }
    socket.once('secureConnect', () => done(true))
    socket.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      done(SERVER_REJECT_CODES.has(code) ? false : null)
    })
  })
}
