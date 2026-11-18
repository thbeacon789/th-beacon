import { MAX_FINDINGS, MAX_RECOMMENDATION, MAX_SUMMARY, MAX_TITLE } from './constants.ts'
import type {
  CertFact, CheckResult, CheckStatus, ExposureFact, ExposureHeaders, Finding, FindingSeverity,
  HourCount, Inventory, JudgedCheckKey, Listener, LogSourceVolume, ScanKind, ScheduledEntry,
  SecurityScanPayload, ValidationResult,
} from './types.ts'

const CLOCK_SKEW_MS = 10 * 60 * 1000
const STATUSES: readonly CheckStatus[] = ['ok', 'warn', 'bad', 'unknown', 'na']
const JUDGED: readonly JudgedCheckKey[] = ['ports', 'updates', 'logins']
const SEVERITIES: readonly FindingSeverity[] = ['high', 'medium', 'low']
const KINDS: readonly ScanKind[] = ['vm', 'hosted']
const HEADER_KEYS: readonly (keyof ExposureHeaders)[] = ['hsts', 'contentTypeOptions', 'frameProtection', 'csp', 'referrerPolicy']

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const validDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(new Date(v).getTime())

/** 字串欄位：型別錯回 null 並記錄錯誤；成功回 trim 後的值 */
function str(v: unknown, path: string, errors: string[], opts: { max?: number; allowEmpty?: boolean } = {}): string | null {
  if (typeof v !== 'string') {
    errors.push(`${path} 必須是字串`)
    return null
  }
  const t = v.trim()
  if (t.length === 0 && !opts.allowEmpty) {
    errors.push(`${path} 不可為空`)
    return null
  }
  if (opts.max !== undefined && t.length > opts.max) {
    errors.push(`${path} 不可超過 ${opts.max} 字`)
    return null
  }
  return t
}

function arr(v: unknown, path: string, errors: string[]): unknown[] | null {
  if (!Array.isArray(v)) {
    errors.push(`${path} 必須是陣列`)
    return null
  }
  return v
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string, errors: string[]): T | null {
  if ((allowed as readonly unknown[]).includes(v)) return v as T
  errors.push(`${path} 必須是 ${allowed.join('／')}`)
  return null
}

function strArray(v: unknown, path: string, errors: string[]): string[] | null {
  const a = arr(v, path, errors)
  if (!a) return null
  const out: string[] = []
  a.forEach((x, i) => {
    const s = str(x, `${path}[${i}]`, errors)
    if (s !== null) out.push(s)
  })
  return out
}

function parseChecks(v: unknown, errors: string[]): Record<JudgedCheckKey, CheckResult> | null {
  if (!isObj(v)) {
    errors.push('checks 必須是物件')
    return null
  }
  const out = {} as Record<JudgedCheckKey, CheckResult>
  let ok = true
  for (const key of JUDGED) {
    const c = v[key]
    if (!isObj(c)) {
      errors.push(`checks.${key} 必須是物件`)
      ok = false
      continue
    }
    const status = oneOf(c.status, STATUSES, `checks.${key}.status`, errors)
    const summary = str(c.summary, `checks.${key}.summary`, errors, { max: MAX_SUMMARY, allowEmpty: true })
    if (status !== null && summary !== null && summary.length === 0 && status !== 'na' && status !== 'unknown') {
      errors.push(`checks.${key}.summary 在 status 為 ${status} 時不可為空`)
      ok = false
    }
    if (status === null || summary === null) ok = false
    else out[key] = { status, summary }
  }
  return ok ? out : null
}

function parseFindings(v: unknown, errors: string[]): Finding[] | null {
  const a = arr(v, 'findings', errors)
  if (!a) return null
  if (a.length > MAX_FINDINGS) {
    errors.push(`findings 不可超過 ${MAX_FINDINGS} 筆`)
    return null
  }
  const out: Finding[] = []
  a.forEach((f, i) => {
    const p = `findings[${i}]`
    if (!isObj(f)) {
      errors.push(`${p} 必須是物件`)
      return
    }
    const check = oneOf(f.check, JUDGED, `${p}.check`, errors)
    const severity = oneOf(f.severity, SEVERITIES, `${p}.severity`, errors)
    const title = str(f.title, `${p}.title`, errors, { max: MAX_TITLE })
    const recommendation = str(f.recommendation, `${p}.recommendation`, errors, { max: MAX_RECOMMENDATION, allowEmpty: true })
    if (check && severity && title !== null && recommendation !== null) out.push({ check, severity, title, recommendation })
  })
  return out
}

function parseCerts(v: unknown, errors: string[]): CertFact[] | null {
  const a = arr(v, 'certs', errors)
  if (!a) return null
  const out: CertFact[] = []
  a.forEach((c, i) => {
    const p = `certs[${i}]`
    if (!isObj(c)) {
      errors.push(`${p} 必須是物件`)
      return
    }
    const domain = str(c.domain, `${p}.domain`, errors)
    let notAfter: string | null = null
    if (validDate(c.notAfter)) notAfter = c.notAfter.trim()
    else errors.push(`${p}.notAfter 必須是可解析的日期`)
    const cert: CertFact | null = domain !== null && notAfter !== null ? { domain, notAfter } : null
    if (c.trusted !== undefined) {
      if (typeof c.trusted === 'boolean') {
        if (cert) cert.trusted = c.trusted
      } else errors.push(`${p}.trusted 必須是布林`)
    }
    if (c.error !== undefined) {
      const e = str(c.error, `${p}.error`, errors, { max: 120, allowEmpty: true })
      if (e !== null && cert && e.length > 0) cert.error = e
    }
    if (cert) out.push(cert)
  })
  return out
}

function parseExposure(v: unknown, errors: string[]): ExposureFact[] | null {
  const a = arr(v, 'exposure', errors)
  if (!a) return null
  const out: ExposureFact[] = []
  a.forEach((e, i) => {
    const p = `exposure[${i}]`
    if (!isObj(e)) {
      errors.push(`${p} 必須是物件`)
      return
    }
    const domain = str(e.domain, `${p}.domain`, errors)
    let ok = domain !== null

    let headers: ExposureHeaders | null = null
    if (isObj(e.headers)) {
      const h = {} as ExposureHeaders
      let hOk = true
      for (const k of HEADER_KEYS) {
        const val = e.headers[k]
        if (typeof val !== 'boolean') {
          errors.push(`${p}.headers.${k} 必須是布林`)
          hOk = false
        } else h[k] = val
      }
      if (hOk) headers = h
    } else errors.push(`${p}.headers 必須是物件`)
    if (!headers) ok = false

    let legacyTls: boolean | null = null
    if (e.legacyTls === true || e.legacyTls === false || e.legacyTls === null) legacyTls = e.legacyTls
    else {
      errors.push(`${p}.legacyTls 必須是 true／false／null`)
      ok = false
    }

    const sensitivePaths: Array<{ path: string; exposed: boolean }> = []
    const sp = arr(e.sensitivePaths, `${p}.sensitivePaths`, errors)
    if (sp) {
      sp.forEach((s, j) => {
        const sp2 = `${p}.sensitivePaths[${j}]`
        if (!isObj(s)) {
          errors.push(`${sp2} 必須是物件`)
          ok = false
          return
        }
        const path = str(s.path, `${sp2}.path`, errors)
        if (path !== null && !path.startsWith('/')) {
          errors.push(`${sp2}.path 必須以 / 開頭`)
          ok = false
        } else if (path === null) ok = false
        if (typeof s.exposed !== 'boolean') {
          errors.push(`${sp2}.exposed 必須是布林`)
          ok = false
        } else if (path !== null) sensitivePaths.push({ path, exposed: s.exposed })
      })
    } else ok = false

    if (ok && domain !== null && headers) out.push({ domain, sensitivePaths, headers, legacyTls })
  })
  return out
}

function parseLogVolume(v: unknown, errors: string[]): LogSourceVolume[] | null {
  const a = arr(v, 'logVolume', errors)
  if (!a) return null
  const out: LogSourceVolume[] = []
  a.forEach((l, i) => {
    const p = `logVolume[${i}]`
    if (!isObj(l)) {
      errors.push(`${p} 必須是物件`)
      return
    }
    const source = str(l.source, `${p}.source`, errors)
    const hasError = l.error !== undefined
    const hasHourly = l.hourly !== undefined
    if (hasError === hasHourly) {
      errors.push(`${p} 必須擇一提供 error 或 hourly`)
      return
    }
    if (hasError) {
      if (l.error !== true) {
        errors.push(`${p}.error 只能是 true`)
        return
      }
      if (source !== null) out.push({ source, error: true })
      return
    }
    const hourly: HourCount[] = []
    const h = arr(l.hourly, `${p}.hourly`, errors)
    let ok = source !== null && h !== null
    h?.forEach((x, j) => {
      const hp = `${p}.hourly[${j}]`
      if (!isObj(x)) {
        errors.push(`${hp} 必須是物件`)
        ok = false
        return
      }
      const hourOk = validDate(x.hour)
      if (!hourOk) errors.push(`${hp}.hour 必須是可解析的日期`)
      const countOk = typeof x.count === 'number' && Number.isInteger(x.count) && x.count >= 0
      if (!countOk) errors.push(`${hp}.count 必須是非負整數`)
      if (hourOk && countOk) hourly.push({ hour: (x.hour as string).trim(), count: x.count as number })
      else ok = false
    })
    if (ok && source !== null) out.push({ source, hourly })
  })
  return out
}

function parseInventory(v: unknown, errors: string[]): Inventory | null {
  if (!isObj(v)) {
    errors.push('inventory 必須是物件')
    return null
  }
  const before = errors.length
  const users = strArray(v.users, 'inventory.users', errors)
  const admins = strArray(v.admins, 'inventory.admins', errors)
  const services = strArray(v.services, 'inventory.services', errors)

  const sshKeys: Inventory['sshKeys'] = []
  arr(v.sshKeys, 'inventory.sshKeys', errors)?.forEach((k, i) => {
    const p = `inventory.sshKeys[${i}]`
    if (!isObj(k)) return void errors.push(`${p} 必須是物件`)
    const user = str(k.user, `${p}.user`, errors)
    const fingerprint = str(k.fingerprint, `${p}.fingerprint`, errors)
    if (user !== null && fingerprint !== null) sshKeys.push({ user, fingerprint })
  })

  const scheduled: ScheduledEntry[] = []
  arr(v.scheduled, 'inventory.scheduled', errors)?.forEach((s, i) => {
    const p = `inventory.scheduled[${i}]`
    if (!isObj(s)) return void errors.push(`${p} 必須是物件`)
    const location = str(s.location, `${p}.location`, errors)
    const schedule = str(s.schedule, `${p}.schedule`, errors, { allowEmpty: true })
    const executable = str(s.executable, `${p}.executable`, errors, { allowEmpty: true })
    const hash = str(s.hash, `${p}.hash`, errors, { allowEmpty: true })
    if (location !== null && schedule !== null && executable !== null && hash !== null) {
      scheduled.push({ location, schedule, executable, hash })
    }
  })

  const listeners: Listener[] = []
  arr(v.listeners, 'inventory.listeners', errors)?.forEach((l, i) => {
    const p = `inventory.listeners[${i}]`
    if (!isObj(l)) return void errors.push(`${p} 必須是物件`)
    const proto = oneOf(l.proto, ['tcp', 'udp'] as const, `${p}.proto`, errors)
    const portOk = typeof l.port === 'number' && Number.isInteger(l.port) && l.port >= 1 && l.port <= 65535
    if (!portOk) errors.push(`${p}.port 必須是 1–65535 的整數`)
    const process = str(l.process, `${p}.process`, errors, { allowEmpty: true })
    if (proto && portOk && process !== null) listeners.push({ proto, port: l.port as number, process })
  })

  if (errors.length > before || !users || !admins || !services) return null
  return { users, admins, sshKeys, scheduled, listeners, services }
}

export function parseSecurityScanPayload(input: unknown, now: Date): ValidationResult<SecurityScanPayload> {
  if (!isObj(input)) return { ok: false, errors: ['payload 必須是 JSON 物件'] }
  const errors: string[] = []

  let scannedAt: string | null = null
  if (!validDate(input.scannedAt)) errors.push('scannedAt 必須是可解析的日期')
  else if (new Date(input.scannedAt).getTime() > now.getTime() + CLOCK_SKEW_MS) errors.push('scannedAt 不可晚於現在超過 10 分鐘')
  else scannedAt = input.scannedAt.trim()

  const kind = oneOf(input.kind, KINDS, 'kind', errors)
  const checks = parseChecks(input.checks, errors)
  const findings = parseFindings(input.findings, errors)
  const certs = parseCerts(input.certs, errors)
  const exposure = parseExposure(input.exposure, errors)
  const logVolume = input.logVolume === undefined ? undefined : parseLogVolume(input.logVolume, errors)
  const inventory = input.inventory === undefined ? undefined : parseInventory(input.inventory, errors)

  if (errors.length > 0 || !scannedAt || !kind || !checks || !findings || !certs || !exposure) {
    return { ok: false, errors }
  }
  const value: SecurityScanPayload = { scannedAt, kind, checks, findings, certs, exposure }
  if (logVolume) value.logVolume = logVolume
  if (inventory) value.inventory = inventory
  return { ok: true, value }
}
