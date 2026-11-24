// 注意：本檔會被 Node 直接執行（type stripping），import 只能用相對路徑加 .ts 副檔名。
// 輸入（VM 輸出）為不可信資料：只做字串切割與固定樣式比對，格式不符的行一律略過。
import type { ContainerEntry, ImageEntry, Inventory, Listener, LogSourceVolume, ScheduledEntry } from '../types.ts'

export interface VmFacts {
  listeners: Array<Listener & { address: string }>
  updates: {
    upgradable: number
    security: number
    packages: string[]
    securityPackages: string[]
    rebootRequired: boolean
    osVersion: string
    autoUpdatesEnabled: boolean | null
  }
  ssh: { passwordAuthentication: boolean | null; permitRootLogin: string | null }
  authLines: string[]
  inventory: Inventory
  logVolume: LogSourceVolume[]
  /** 映像檔區段（非必要區段：缺漏或 ERROR 都只是 failed: true，不讓整次掃描失敗） */
  images: { entries: ImageEntry[] | undefined; failed: boolean }
  /** dump 中不存在標記的必要區段（存在但內容為空不算缺漏） */
  missingSections: string[]
}

export const REQUIRED_SECTIONS: readonly string[] = [
  'listeners', 'apt_upgradable', 'reboot_required', 'os_release', 'auto_updates', 'sshd',
  'auth', 'users', 'admins', 'ssh_keys', 'scheduled', 'services', 'containers',
]

const NONCE_RE = /^[a-f0-9]{32}$/
const SECTION_NAME_RE = /^[A-Za-z0-9_:.-]+$/
const HOUR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9+.:_-]*$/

/** 依 nonce 切出區段；標記必須整行完全相等，其餘（含偽造的標記）一律視為內容。 */
export function splitSections(dump: string, nonce: string): Record<string, string> {
  if (!NONCE_RE.test(nonce)) throw new Error('nonce 格式不符（需為 32 碼小寫十六進位）')
  const prefix = `@@BEACON:${nonce}:`
  const suffix = '@@'
  const sections: Record<string, string> = Object.create(null)
  let current: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (current !== null && !(current in sections)) sections[current] = buf.join('\n')
    buf = []
  }
  const text = dump.endsWith('\n') ? dump.slice(0, -1) : dump
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith(prefix) && line.endsWith(suffix) && line.length > prefix.length + suffix.length) {
      const name = line.slice(prefix.length, line.length - suffix.length)
      if (SECTION_NAME_RE.test(name) && line === `${prefix}${name}${suffix}`) {
        flush()
        current = name
        continue
      }
    }
    if (current !== null) buf.push(line)
  }
  flush()
  return sections
}

const lines = (s: string | undefined): string[] => (s ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0)

function parseListeners(s: string | undefined): Array<Listener & { address: string }> {
  const out: Array<Listener & { address: string }> = []
  const seen = new Set<string>()
  for (const line of lines(s)) {
    const cols = line.split(/\s+/)
    if (cols.length < 6) continue
    const netid = cols[0]
    const proto = netid.startsWith('tcp') ? 'tcp' : netid.startsWith('udp') ? 'udp' : null
    if (!proto) continue
    const local = cols[4]
    const idx = local.lastIndexOf(':')
    if (idx < 0) continue
    const portStr = local.slice(idx + 1)
    if (!/^\d{1,5}$/.test(portStr)) continue
    const port = Number(portStr)
    if (port < 1 || port > 65535) continue
    // 去除 IPv6 方括號與 %lo 之類的 zone
    const address = local.slice(0, idx).replace(/^\[|\]$/g, '').replace(/%.*$/, '')
    const m = /\(\("([^"]*)"/.exec(line)
    const process = m ? m[1] : ''
    const key = `${proto}|${address}|${port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ proto, port, process, address })
  }
  return out
}

function parseUpdates(sections: Record<string, string>): VmFacts['updates'] {
  const packages: string[] = []
  const securityPackages: string[] = []
  for (const line of lines(sections.apt_upgradable)) {
    if (line.startsWith('Listing')) continue
    const slash = line.indexOf('/')
    if (slash <= 0) continue
    const name = line.slice(0, slash)
    if (!PACKAGE_RE.test(name)) continue
    packages.push(name)
    const source = line.slice(slash + 1).split(/\s+/)[0] ?? ''
    if (source.split(',').some((x) => x.endsWith('-security'))) securityPackages.push(name)
  }
  const check = /^(\d+);(\d+)$/.exec((sections.apt_check ?? '').trim())
  const upgradable = check ? Number(check[1]) : packages.length
  const security = check ? Number(check[2]) : securityPackages.length

  const osMatch = /^VERSION_ID=("?)([^"\n]*)\1$/m.exec(sections.os_release ?? '')
  const auto = sections.auto_updates ?? ''
  const autoUpdatesEnabled = auto.includes('"1"') ? true : auto.includes('"0"') ? false : null

  return {
    upgradable,
    security,
    packages,
    securityPackages,
    rebootRequired: (sections.reboot_required ?? '').trim() === 'yes',
    osVersion: osMatch ? osMatch[2].trim() : '',
    autoUpdatesEnabled,
  }
}

function parseSsh(s: string | undefined): VmFacts['ssh'] {
  let passwordAuthentication: boolean | null = null
  let permitRootLogin: string | null = null
  for (const line of lines(s)) {
    const [key, value] = line.split(/\s+/)
    if (value === undefined) continue
    const k = key.toLowerCase()
    const v = value.toLowerCase()
    if (k === 'passwordauthentication') passwordAuthentication = v === 'yes' ? true : v === 'no' ? false : null
    else if (k === 'permitrootlogin') permitRootLogin = v
  }
  return { passwordAuthentication, permitRootLogin }
}

function parseScheduled(s: string | undefined): ScheduledEntry[] {
  const out: ScheduledEntry[] = []
  for (const line of (s ?? '').split('\n')) {
    const clean = line.replace(/\r$/, '')
    if (clean.trim().length === 0) continue
    const p = clean.split('\t')
    // 欄位內可能被塞入 TAB：絕不能讓一行排程資料無聲消失
    if (p.length >= 4) {
      out.push({ location: p[0], schedule: p[1], executable: p.slice(2, -1).join(' '), hash: p[p.length - 1] })
    } else {
      out.push({ location: p[0].trim() === '' ? '(unparsed)' : p[0], schedule: '', executable: '', hash: p[p.length - 1] })
    }
  }
  return out
}

function parseSshKeys(s: string | undefined): Inventory['sshKeys'] {
  const out: Inventory['sshKeys'] = []
  for (const line of (s ?? '').split('\n')) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const user = line.slice(0, tab).trim()
    const fingerprint = line.slice(tab + 1).trim()
    if (user && fingerprint) out.push({ user, fingerprint })
  }
  return out
}

const UNTAGGED = '<untagged>'

/** 映像檔來源（不含版本）：去掉 @digest 與 tag；映像檔 ID（本機未標記建置）一律記為 <untagged>。 */
export function normalizeImage(raw: string): string {
  let s = raw.trim()
  if (/^sha256:/.test(s) || /^[0-9a-f]{12,64}$/.test(s)) return UNTAGGED
  const at = s.indexOf('@')
  if (at >= 0) s = s.slice(0, at)
  // registry 可帶埠號（host:5000/app:tag），只有最後一個 / 之後的 : 才是 tag
  const colon = s.lastIndexOf(':')
  if (colon > s.lastIndexOf('/')) s = s.slice(0, colon)
  return s === '' ? UNTAGGED : s
}

/** 只留發佈到主機的對應（含 ->），排序並去重；未發佈的（如 3000/tcp）捨棄。 */
export function normalizePorts(raw: string): string[] {
  const out = new Set<string>()
  for (const p of raw.split(',')) {
    // Docker 不同版本把 IPv6 綁定寫成 `:::80->…` 或 `[::]:80->…`，統一成後者（IPv4 與 IPv6 不合併）
    const t = p.trim().replace(/^:::/, '[::]:')
    if (t.includes('->')) out.add(t)
  }
  return [...out].sort()
}

/** 容器區段：NONE → undefined；ERROR → failed（呼叫端視為區段缺漏）；其餘逐行解析，未知格式保留為哨兵項目。 */
function parseContainers(s: string | undefined): { containers: ContainerEntry[] | undefined; failed: boolean } {
  const body = lines(s)
  if (body.includes('ERROR')) return { containers: undefined, failed: true }
  if (body.length === 1 && body[0] === 'NONE') return { containers: undefined, failed: false }
  const out: ContainerEntry[] = []
  for (const raw of (s ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    if (line.startsWith('?container:') && !line.includes('\t')) {
      out.push({ name: line.trim(), image: '?', ports: [] })
      continue
    }
    const p = line.split('\t')
    // 行尾 TAB 可能被傳輸層去掉：無埠容器只剩 2 欄，ports 視為空
    if ((p.length !== 3 && p.length !== 2) || p[0].trim() === '' || p[1].trim() === '') {
      out.push({ name: '?container:unparsed', image: '?', ports: [] })
      continue
    }
    out.push({ name: p[0].trim(), image: normalizeImage(p[1]), ports: normalizePorts(p[2] ?? '') })
  }
  return { containers: out, failed: false }
}

/**
 * images 區段：NONE → undefined；ERROR 或缺區段 → failed。
 * 收集端的哨兵行（?image:<雜湊>）與欄位數不符的行不可略過：各產生一筆 imageId 為 '' 的項目，
 * 表示「這個容器的映像檔無法查詢」，由 planImageScans 轉成帶 error 的 target，deps 因此判 unknown。
 * 佔位名稱符合 payload 的字元白名單（image `unknown`、container `unknown-<雜湊前 12 碼>`）。
 */
function parseImages(s: string | undefined): VmFacts['images'] {
  if (s === undefined) return { entries: undefined, failed: true }
  const body = lines(s)
  if (body.includes('ERROR')) return { entries: undefined, failed: true }
  if (body.length === 1 && body[0] === 'NONE') return { entries: undefined, failed: false }
  const entries: ImageEntry[] = []
  for (const raw of s.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    const unresolved = (suffix: string): ImageEntry => ({ container: `unknown-${suffix}`, configImage: 'unknown', imageId: '', repoDigests: [] })
    const sentinel = /^\?image:([a-f0-9]{16})$/.exec(line.trim())
    if (sentinel) {
      entries.push(unresolved(sentinel[1].slice(0, 12)))
      continue
    }
    const p = line.split('\t')
    // 行尾 TAB 可能被傳輸層去掉：沒有 RepoDigests 時只剩 3 欄
    if ((p.length !== 4 && p.length !== 3) || p[0].trim() === '' || p[1].trim() === '' || p[2].trim() === '') {
      entries.push(unresolved('unparsed'))
      continue
    }
    const repoDigests = (p[3] ?? '').split(',').map((x) => x.trim()).filter((x) => x.length > 0)
    entries.push({ container: p[0].trim(), configImage: p[1].trim(), imageId: p[2].trim(), repoDigests })
  }
  return { entries, failed: false }
}

function parseLogVolume(sections: Record<string, string>): LogSourceVolume[] {
  const out: LogSourceVolume[] = []
  for (const name of Object.keys(sections)) {
    if (!name.startsWith('log:')) continue
    const source = name.slice(4)
    if (source.length === 0) continue
    const body = sections[name]
    const bodyLines = lines(body)
    // 收集端串流輸出，失敗時可能在資料行之後才附上 ERROR，所以任何一行為 ERROR 都算失敗
    if (bodyLines.includes('ERROR')) {
      out.push({ source, error: true })
      continue
    }
    const hourly: Array<{ hour: string; count: number }> = []
    for (const line of bodyLines) {
      const [hour, count, ...rest] = line.split('\t')
      if (rest.length > 0 || hour === undefined || count === undefined) continue
      if (!HOUR_RE.test(hour) || !/^\d{1,12}$/.test(count)) continue
      hourly.push({ hour, count: Number(count) })
    }
    // 內容非空卻沒有任何一行可解析：來源壞了，不是「沒有 log」（空內容才是 hourly: []）
    if (bodyLines.length > 0 && hourly.length === 0) {
      out.push({ source, error: true })
      continue
    }
    // 收集端為了固定記憶體不排序輸出，這裡依時間排序
    hourly.sort((x, y) => (x.hour < y.hour ? -1 : x.hour > y.hour ? 1 : 0))
    out.push({ source, hourly })
  }
  return out
}

export function parseVmDump(dump: string, nonce: string): VmFacts {
  const sections = splitSections(dump, nonce)
  const listeners = parseListeners(sections.listeners)

  const invListeners: Listener[] = []
  const seen = new Set<string>()
  for (const l of listeners) {
    const key = `${l.proto}|${l.port}`
    if (seen.has(key)) continue
    seen.add(key)
    invListeners.push({ proto: l.proto, port: l.port, process: l.process })
  }
  // 同 proto+port 若先出現的行取不到行程名，改用後面有名稱的
  for (const l of listeners) {
    const target = invListeners.find((x) => x.proto === l.proto && x.port === l.port)
    if (target && target.process === '' && l.process !== '') target.process = l.process
  }

  const containers = parseContainers(sections.containers)
  const inventory: Inventory = {
    users: lines(sections.users),
    admins: lines(sections.admins),
    sshKeys: parseSshKeys(sections.ssh_keys),
    scheduled: parseScheduled(sections.scheduled),
    listeners: invListeners,
    services: lines(sections.services),
  }
  if (containers.containers !== undefined) inventory.containers = containers.containers
  // docker 存在卻無法取得清單：收集失敗不可顯示成正常，併入缺漏區段讓整次掃描失敗
  const missingSections = REQUIRED_SECTIONS.filter((n) => !(n in sections) || (n === 'containers' && containers.failed))

  return {
    listeners,
    updates: parseUpdates(sections),
    ssh: parseSsh(sections.sshd),
    authLines: lines(sections.auth),
    inventory,
    logVolume: parseLogVolume(sections),
    images: parseImages(sections.images),
    missingSections,
  }
}
