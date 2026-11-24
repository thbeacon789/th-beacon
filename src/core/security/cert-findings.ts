// 寫入端：逐網域推導憑證發現（reconcile 需要每個 domain 各自被評估，不能只取最早到期那張）
import { CERT_BAD_DAYS, CERT_WARN_DAYS } from './constants.ts'
import type { CertFact, Finding } from './types.ts'

const DAY_MS = 86400000
const RECOMMENDATION = '更新憑證，並確認自動續期是否正常'

export function evaluateCertFindings(certs: CertFact[], scannedAt: Date): Finding[] {
  const findings: Finding[] = []
  for (const c of certs) {
    if (c.trusted === false) {
      findings.push({
        check: 'cert',
        key: `untrusted:${c.domain}`,
        severity: 'high',
        title: `${c.domain} 的 SSL 憑證不受信任（${c.error && c.error.length > 0 ? c.error : '未知原因'}）`,
        recommendation: '檢查憑證鏈與網域名稱是否相符，重新簽發憑證',
      })
    }
    const key = `expiry:${c.domain}`
    const diff = Date.parse(c.notAfter) - scannedAt.getTime()
    if (diff <= 0) {
      findings.push({ check: 'cert', key, severity: 'high', title: `${c.domain} 的 SSL 憑證已過期`, recommendation: RECOMMENDATION })
      continue
    }
    const days = Math.floor(diff / DAY_MS)
    const title = `${c.domain} 的 SSL 憑證剩 ${days} 天到期`
    if (days < CERT_BAD_DAYS) findings.push({ check: 'cert', key, severity: 'high', title, recommendation: RECOMMENDATION })
    else if (days < CERT_WARN_DAYS) findings.push({ check: 'cert', key, severity: 'medium', title, recommendation: RECOMMENDATION })
  }
  return findings
}
