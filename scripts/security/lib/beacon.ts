// 注意：本檔以 Node 直接執行（type stripping）。只用相對路徑加 .ts 副檔名與 Node 內建模組。
import { createHmac } from 'node:crypto'

export function sign(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
}

/** 簽章後 POST JSON；回傳狀態碼與回應 body 的前 200 字（不含任何秘密）。網路錯誤會 throw（訊息不含秘密）。 */
export async function postSigned(
  url: string,
  service: string,
  secret: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const raw = JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'x-beacon-service': service,
        'x-beacon-timestamp': timestamp,
        'x-beacon-signature': sign(secret, timestamp, raw),
      },
      body: raw,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw new Error(`推送失敗：${e instanceof Error ? e.name : 'error'}`)
  }
  const text = await res.text().catch(() => '')
  return { status: res.status, body: text.slice(0, 200) }
}
