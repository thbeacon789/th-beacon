/**
 * Dashboard 時間顯示。
 *
 * 這些字串都在 server component 產生，所以「預設時區」是**伺服器**的時區：
 * 本機是 Asia/Taipei，Vercel serverless 是 UTC——同一筆資料兩邊會差 8 小時。
 * 因此時區一律顯式指定，不吃執行環境。
 *
 * hourCycle 用 'h23' 而非 hour12:false：zh-TW 在部分 ICU 版本下 hour12:false
 * 會把午夜印成 24:00，h23 才穩定給 00:00。
 */
const TIME_ZONE = 'Asia/Taipei'

const DATE_TIME = new Intl.DateTimeFormat('zh-TW', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const DATE_TIME_SECONDS = new Intl.DateTimeFormat('zh-TW', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** 台北時間 24 小時制，到分鐘：2026/07/29 19:23 */
export function formatDateTime(iso: string): string {
  return DATE_TIME.format(new Date(iso))
}

/** 同上但保留秒——只給原始 event 時間軸，事件密集時秒數才分得出先後 */
export function formatDateTimeSeconds(iso: string): string {
  return DATE_TIME_SECONDS.format(new Date(iso))
}
