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
    form.append(`files[${i}]`, new Blob([f.data as BlobPart], { type: f.contentType }), f.filename)
  })
  return form
}
