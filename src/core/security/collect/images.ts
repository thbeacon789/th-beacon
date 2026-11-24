// 注意：本檔會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。
// 輸入（VM 輸出）為不可信資料：digest 字串必須符合固定樣式才採用。
import type { ImageEntry } from '../types.ts'

export interface ScanTarget {
  /** 不含 tag／digest 的 repository */
  image: string
  digest: string | null
  /** `<repository>@sha256:<hex>`；無可用 digest 時為 null */
  ref: string | null
  containers: string[]
  /** 已知無法掃描的原因（例如容器無法查詢）；有值時不呼叫 runner，直接帶出為該映像檔的 error */
  error?: string
}

const DIGEST_RE = /^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[a-f0-9]{64}$/

/** 去掉 @digest 與 tag；registry 可帶埠號，只有最後一個 / 之後的 : 才是 tag。 */
function repositoryOf(raw: string): string {
  let s = raw.trim()
  const at = s.indexOf('@')
  if (at >= 0) s = s.slice(0, at)
  const colon = s.lastIndexOf(':')
  if (colon > s.lastIndexOf('/')) s = s.slice(0, colon)
  return s
}

export function planImageScans(entries: ImageEntry[]): ScanTarget[] {
  const groups = new Map<string, ImageEntry[]>()
  for (const e of entries) {
    // imageId 為 ''＝無法查詢的哨兵：每個容器各自成一組，不可合併成同一個映像檔
    const key = e.imageId === '' ? `?${e.container}` : e.imageId
    const g = groups.get(key)
    if (g) g.push(e)
    else groups.set(key, [e])
  }
  const targets: ScanTarget[] = []
  for (const group of groups.values()) {
    if (group[0].imageId === '') {
      targets.push({ image: 'unknown', digest: null, ref: null, containers: [group[0].container], error: '無法查詢容器' })
      continue
    }
    const want = repositoryOf(group[0].configImage)
    const valid = group[0].repoDigests.filter((d) => DIGEST_RE.test(d))
    const picked = valid.find((d) => d.slice(0, d.indexOf('@')) === want) ?? valid[0]
    const containers = [...new Set(group.map((e) => e.container))].sort()
    if (picked === undefined) {
      targets.push({ image: want, digest: null, ref: null, containers })
    } else {
      const at = picked.indexOf('@')
      targets.push({ image: picked.slice(0, at), digest: picked.slice(at + 1), ref: picked, containers })
    }
  }
  return targets.sort((a, b) => (a.image < b.image ? -1 : a.image > b.image ? 1 : 0))
}
