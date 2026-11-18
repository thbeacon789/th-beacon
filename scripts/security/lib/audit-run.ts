// 注意：本檔以 Node 直接執行（type stripping）。只用 Node 內建模組。
// 目標 repo 的內容不受本 repo 控制：稽核不得在其目錄內執行，也不得繼承 runner 的秘密環境變數。
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 稽核子行程的最小環境：不展開 process.env，秘密（BEACON_SECRET、ANTHROPIC_*、OIDC 權杖）不外流 */
export function auditEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  if (source.PATH !== undefined) env.PATH = source.PATH
  if (source.HOME !== undefined) env.HOME = source.HOME
  // 縱深防禦：不讓 corepack 依專案規格（packageManager 欄位）選用／下載套件管理器
  env.COREPACK_ENABLE_STRICT = '0'
  env.COREPACK_ENABLE_PROJECT_SPEC = '0'
  env.CI = 'true'
  env.npm_config_ignore_scripts = 'true'
  return env
}

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024
const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024
const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')
}

/** 確認為一般檔案且不超過大小上限，否則 throw */
function checkRegularFile(src: string, name: string, maxBytes: number): void {
  const st = lstatSync(src)
  if (!st.isFile()) throw new Error(`${name} 不是一般檔案`)
  if (st.size > maxBytes) throw new Error(`${name} 超過大小上限（${maxBytes} bytes）`)
}

/**
 * 建立全新暫存目錄，寫入淨化過的 package.json 並複製 lockfile（皆須為一般檔案且有大小上限）。
 * package.json 只保留 dependencies 類三個鍵（packageManager、scripts、pnpm、overrides 等一律不帶），
 * 避免目標 repo 透過 corepack 決定 runner 上執行的 pnpm。
 * 不複製 .npmrc、.pnpmfile.cjs、pnpm-workspace.yaml 等任何其他檔。失敗時清掉暫存目錄並 throw。
 */
export function prepareAuditDir(repoDir: string, manager: 'pnpm' | 'npm'): string {
  const lock = manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'
  const dir = mkdtempSync(join(tmpdir(), 'beacon-audit-'))
  try {
    const pkgSrc = join(repoDir, 'package.json')
    checkRegularFile(pkgSrc, 'package.json', MAX_PACKAGE_JSON_BYTES)
    const parsed: unknown = JSON.parse(readFileSync(pkgSrc, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('package.json 不是物件')
    const clean: Record<string, unknown> = { name: 'audit-target', version: '0.0.0', private: true }
    for (const k of DEP_KEYS) {
      const v = (parsed as Record<string, unknown>)[k]
      if (isStringRecord(v)) clean[k] = v
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(clean, null, 2))

    const lockSrc = join(repoDir, lock)
    checkRegularFile(lockSrc, lock, MAX_LOCKFILE_BYTES)
    copyFileSync(lockSrc, join(dir, lock))
    return dir
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}
