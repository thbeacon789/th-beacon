// 服務／心跳登記的輸入驗證。純函式，無 I/O、無時鐘——與 heartbeat/payload.ts 同樣的
// { ok } 判別聯集慣例，讓 server action 與測試共用同一份規則。

export interface ServiceRegistrationInput {
  name: string
}

export interface HeartbeatRegistrationInput {
  name: string
  intervalSeconds: number
  graceSeconds: number
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

// 名稱會進 `X-Beacon-Service` header、Discord 訊息與 fingerprint。限縮成 kebab-case
// ASCII 是刻意的：header 值若含空白或非 ASCII，各家 CI 的 shell 轉義行為不一致，
// 會變成難以診斷的 401（簽章對得上、header 卻在傳輸中被改寫）。
// 表單的 <input pattern> 直接用這個字串（HTML 的 pattern 自帶頭尾錨定，故不含 ^$），
// 驗證用的 RegExp 由它推導——兩者同源，才不會出現「瀏覽器放行但後端擋下」的落差。
export const NAME_PATTERN_SOURCE = '[a-z0-9]([a-z0-9-]*[a-z0-9])?'
const NAME_PATTERN = new RegExp(`^${NAME_PATTERN_SOURCE}$`)
const NAME_MIN = 2
const NAME_MAX = 64

// 一天一次的 Vercel Hobby cron 是逾期掃描的實際解析度，interval 低於一天
// 只會讓「逾期」在掃描到之前就先過期一輪。仍允許設定，但下限擋掉明顯的手滑
// （例如把毫秒填進秒的欄位）。
// 這四個值同時是表單 <input> 的 min/max——UI 直接 import，別在那邊另抄一份字面值，
// 否則改了這裡而忘了那裡，使用者會被瀏覽器擋下卻看不到任何錯誤訊息。
export const INTERVAL_MIN = 60
export const INTERVAL_MAX = 30 * 86400
export const GRACE_MIN = 0
export const GRACE_MAX = 7 * 86400

function validateName(raw: unknown, label: string, errors: string[]): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    errors.push(`${label}為必填`)
    return null
  }
  const name = raw.trim()
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    errors.push(`${label}長度須介於 ${NAME_MIN}–${NAME_MAX} 字元`)
    return null
  }
  if (!NAME_PATTERN.test(name)) {
    errors.push(`${label}只能用小寫英數與連字號，且須以英數開頭結尾（例：my-service）`)
    return null
  }
  return name
}

export function validateServiceRegistration(
  input: Record<string, unknown>,
): ValidationResult<ServiceRegistrationInput> {
  const errors: string[] = []
  const name = validateName(input.name, '服務名稱', errors)
  if (name === null || errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { name } }
}

function validateSeconds(
  raw: unknown,
  label: string,
  min: number,
  max: number,
  errors: string[],
): number | null {
  // 表單送來的是字串；Number('') === 0 會讓空值靜默通過下限檢查以外的路徑，故先擋空字串。
  const text = typeof raw === 'string' ? raw.trim() : raw
  if (text === '' || text === undefined || text === null) {
    errors.push(`${label}為必填`)
    return null
  }
  const value = Number(text)
  if (!Number.isInteger(value)) {
    errors.push(`${label}須為整數秒`)
    return null
  }
  if (value < min || value > max) {
    errors.push(`${label}須介於 ${min}–${max} 秒`)
    return null
  }
  return value
}

export function validateHeartbeatRegistration(
  input: Record<string, unknown>,
): ValidationResult<HeartbeatRegistrationInput> {
  const errors: string[] = []
  const name = validateName(input.name, '心跳名稱', errors)
  const intervalSeconds = validateSeconds(
    input.intervalSeconds,
    '回報間隔',
    INTERVAL_MIN,
    INTERVAL_MAX,
    errors,
  )
  const graceSeconds = validateSeconds(
    input.graceSeconds,
    '寬限期',
    GRACE_MIN,
    GRACE_MAX,
    errors,
  )
  if (name === null || intervalSeconds === null || graceSeconds === null || errors.length > 0) {
    return { ok: false, errors }
  }
  return { ok: true, value: { name, intervalSeconds, graceSeconds } }
}
