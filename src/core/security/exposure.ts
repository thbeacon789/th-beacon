import { FALLBACK_KEY } from './constants.ts'
import type { CheckStatus, Evaluation, ExposureFact, Finding } from './types.ts'

const REQUIRED: Array<[keyof ExposureFact['headers'], string]> = [
  ['hsts', 'Strict-Transport-Security'],
  ['contentTypeOptions', 'X-Content-Type-Options'],
  ['frameProtection', 'X-Frame-Options 或 CSP frame-ancestors'],
]
const OPTIONAL: Array<[keyof ExposureFact['headers'], string]> = [
  ['csp', 'Content-Security-Policy'],
  ['referrerPolicy', 'Referrer-Policy'],
]

export function evaluateExposure(facts: ExposureFact[]): Evaluation {
  if (facts.length === 0) return { check: { status: 'unknown', summary: '未檢查' }, findings: [] }

  const findings: Finding[] = []
  const add = (severity: Finding['severity'], title: string, recommendation: string) =>
    findings.push({ check: 'exposure', key: FALLBACK_KEY, severity, title, recommendation })

  for (const f of facts) {
    for (const p of f.sensitivePaths) {
      if (p.exposed) add('high', `${f.domain}${p.path} 可被公開存取`, '立即封鎖該路徑，並輪替其中可能外洩的金鑰')
    }
    for (const [key, name] of REQUIRED) {
      if (!f.headers[key]) add('medium', `${f.domain} 缺少 ${name} 標頭`, `在 ${f.domain} 補上 ${name} 標頭`)
    }
    if (f.legacyTls === true) add('medium', `${f.domain} 仍接受 TLS 1.0／1.1`, `在 ${f.domain} 停用 TLS 1.0／1.1，僅保留 TLS 1.2 以上`)
    for (const [key, name] of OPTIONAL) {
      if (!f.headers[key]) add('low', `${f.domain} 缺少 ${name} 標頭`, `建議在 ${f.domain} 補上 ${name} 標頭`)
    }
  }

  const high = findings.filter((f) => f.severity === 'high').length
  const medium = findings.filter((f) => f.severity === 'medium').length
  let status: CheckStatus = 'ok'
  let summary = '正常'
  if (high > 0) { status = 'bad'; summary = `${high} 個敏感路徑暴露` }
  else if (medium > 0) { status = 'warn'; summary = `缺 ${medium} 項防護` }
  return { check: { status, summary }, findings }
}
