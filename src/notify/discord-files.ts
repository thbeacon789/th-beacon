export const FILE_SEND_TIMEOUT_MS = 20000

export interface DiscordFile {
  filename: string
  data: Uint8Array
  contentType: 'image/png'
}

/**
 * Discord multipart：payload_json ＋ files[n]；attachments[].id 對應 n 與檔名。
 * 呼叫端不可手動設 content-type，讓 fetch 自帶 boundary。
 */
export function buildMultipartBody(payload: Record<string, unknown>, files: DiscordFile[]): FormData {
  const form = new FormData()
  form.append(
    'payload_json',
    JSON.stringify({ ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.filename })) }),
  )
  files.forEach((f, i) => {
    // TS 5.7+ 的 Uint8Array<ArrayBufferLike> 與 BlobPart 型別不相容，但執行期安全：
    // Blob 只複製該 view 的 byteOffset／byteLength 範圍（含 Node Buffer pool 切片），不會多帶底層 buffer。
    form.append(`files[${i}]`, new Blob([f.data as BlobPart], { type: f.contentType }), f.filename)
  })
  return form
}

/** Discord 要求每個 file part 檔名唯一；重名回 false（呼叫端回 duplicate_filename，不發請求） */
export function hasUniqueFilenames(files: DiscordFile[]): boolean {
  return new Set(files.map((f) => f.filename)).size === files.length
}
