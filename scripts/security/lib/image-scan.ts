// 注意：本檔以 Node 直接執行（type stripping）。只用相對路徑加 .ts 副檔名與 Node 內建模組。
// 映像檔 ref 來自 VM 輸出（不可信）：只以參數陣列傳給子行程，不經 shell。
// reason 一律是固定短句（可含 exit code），不含子行程 stdout／stderr 原文。
import { spawnSync } from 'node:child_process'
import { parseOsvImageScan } from '../../../src/core/security/collect/osv.ts'
import type { ScanTarget } from '../../../src/core/security/collect/images.ts'
import type { ImageDeps } from '../../../src/core/security/types.ts'

export interface ImageScanRunner {
  (ref: string): { ok: true; json: unknown } | { ok: false; reason: string }
}

const GCLOUD_AUTH_KEYS = ['GOOGLE_APPLICATION_CREDENTIALS']
const RMI_TIMEOUT_MS = 60 * 1000

/**
 * 映像檔拉取／掃描子行程的最小環境：不展開 process.env，秘密（BEACON_SECRET、ANTHROPIC_*、OIDC 權杖、GCP_*）不外流。
 * gcloud 認證變數（CLOUDSDK_*、GOOGLE_APPLICATION_CREDENTIALS）只給 docker pull，不給 osv-scanner。
 */
export function imageScanEnv(source: NodeJS.ProcessEnv, who: 'docker' | 'osv'): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of ['PATH', 'HOME', 'DOCKER_CONFIG']) {
    const v = source[k]
    if (v !== undefined) env[k] = v
  }
  if (who === 'docker') {
    for (const [k, v] of Object.entries(source)) {
      if (v !== undefined && (k.startsWith('CLOUDSDK_') || GCLOUD_AUTH_KEYS.includes(k))) env[k] = v
    }
  }
  return env
}

/** pull → scan → rmi（不論成敗）。pull 與 scan 共用 timeoutMs 預算，rmi 另給固定 60 秒且失敗只 log。 */
export function dockerOsvRunner(opts: { osvBin: string; timeoutMs: number; env: NodeJS.ProcessEnv }): ImageScanRunner {
  return (ref) => {
    const start = Date.now()
    const remaining = (): number => opts.timeoutMs - (Date.now() - start)
    try {
      const pull = spawnSync('docker', ['pull', ref], {
        env: imageScanEnv(opts.env, 'docker'), encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: Math.max(1, remaining()),
      })
      if (pull.error) return { ok: false, reason: timedOut(pull.error) ? '逾時' : 'docker pull 無法執行' }
      if (pull.status !== 0) return { ok: false, reason: `docker pull 失敗（exit ${pull.status}）` }

      const left = remaining()
      if (left <= 0) return { ok: false, reason: '逾時' }
      const scan = spawnSync(
        opts.osvBin,
        ['scan', 'image', ref, '--x-plugins', 'artifact', '--x-plugins', 'javascript/packagejson', '--format', 'json'],
        { env: imageScanEnv(opts.env, 'osv'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: left },
      )
      if (scan.error) return { ok: false, reason: timedOut(scan.error) ? '逾時' : 'osv-scanner 無法執行' }
      if (scan.status !== 0 && scan.status !== 1) return { ok: false, reason: `osv-scanner 失敗（exit ${scan.status}）` }
      try {
        return { ok: true, json: JSON.parse(scan.stdout) as unknown }
      } catch {
        return { ok: false, reason: 'osv 輸出不是 JSON' }
      }
    } finally {
      const rmi = spawnSync('docker', ['rmi', ref], {
        env: imageScanEnv(opts.env, 'docker'), stdio: 'ignore', timeout: RMI_TIMEOUT_MS,
      })
      if (rmi.error || rmi.status !== 0) console.warn('警告：docker rmi 失敗，略過')
    }
  }
}

function timedOut(e: Error): boolean {
  return (e as NodeJS.ErrnoException).code === 'ETIMEDOUT'
}

/** 逐一掃描（序列）；每個 target 一筆 ImageDeps，失敗帶 error 不丟例外 */
export function scanImages(targets: ScanTarget[], run: ImageScanRunner): ImageDeps[] {
  return targets.map((t): ImageDeps => {
    const base = { image: t.image, digest: t.digest, containers: t.containers }
    if (t.ref === null) return { ...base, error: '無 registry digest' }
    const r = run(t.ref)
    if (!r.ok) return { ...base, error: r.reason }
    try {
      const s = parseOsvImageScan(r.json)
      return { ...base, counts: s.counts, packages: s.packages }
    } catch {
      return { ...base, error: 'osv 輸出無法解析' }
    }
  })
}
