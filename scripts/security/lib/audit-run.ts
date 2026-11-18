// 注意：本檔以 Node 直接執行（type stripping）。只用 Node 內建模組。
// 目標 repo 的內容不受本 repo 控制：稽核不得在其目錄內執行，也不得繼承 runner 的秘密環境變數。
import { copyFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 稽核子行程的最小環境：不展開 process.env，秘密（BEACON_SECRET、ANTHROPIC_*、OIDC 權杖）不外流 */
export function auditEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  if (source.PATH !== undefined) env.PATH = source.PATH
  if (source.HOME !== undefined) env.HOME = source.HOME
  env.CI = 'true'
  env.npm_config_ignore_scripts = 'true'
  return env
}

/**
 * 建立全新暫存目錄，只複製 package.json 與 lockfile（皆須為一般檔案）。
 * 不複製 .npmrc、.pnpmfile.cjs、pnpm-workspace.yaml 等任何其他檔。失敗時清掉暫存目錄並 throw。
 */
export function prepareAuditDir(repoDir: string, manager: 'pnpm' | 'npm'): string {
  const lock = manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'
  const dir = mkdtempSync(join(tmpdir(), 'beacon-audit-'))
  try {
    for (const name of ['package.json', lock]) {
      const src = join(repoDir, name)
      if (!lstatSync(src).isFile()) throw new Error(`${name} 不是一般檔案`)
      copyFileSync(src, join(dir, name))
    }
    return dir
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}
