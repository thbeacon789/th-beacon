// 字型一次讀入並快取（module scope Promise）。Noto Sans TC 為中文 fallback：
// 拉丁字型只含拉丁字元，Satori 無系統字型可 fallback，不補中文會全變方塊。
import { readFile } from 'node:fs/promises'
import path from 'node:path'

type Weight = 400 | 700
export interface ReportFont { name: string; data: ArrayBuffer; weight: Weight; style: 'normal' }

const SPECS: Array<{ name: string; file: string; weight: Weight }> = [
  { name: 'New-Gen', file: 'New-Gen.ttf', weight: 400 },
  { name: 'Aurora', file: 'Aurora-BC.ttf', weight: 700 },
  { name: 'Pixel', file: 'Pixel-12x10.ttf', weight: 400 },
  { name: 'Noto Sans TC', file: 'NotoSansTC-Regular.otf', weight: 400 },
  { name: 'Noto Sans TC', file: 'NotoSansTC-Bold.otf', weight: 700 },
]

async function load(): Promise<ReportFont[]> {
  return Promise.all(
    SPECS.map(async ({ name, file, weight }) => {
      const buf = await readFile(path.join(process.cwd(), 'src/fonts', file))
      const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      return { name, data, weight, style: 'normal' as const }
    }),
  )
}

let cached: Promise<ReportFont[]> | null = null
export function getReportFonts(): Promise<ReportFont[]> {
  // 讀取失敗時不快取失敗結果，下次重試
  cached ??= load().catch((e) => { cached = null; throw e })
  return cached
}
