import { describe, it, expect } from 'vitest'
import {
  validateServiceRegistration,
  validateHeartbeatRegistration,
  validateServiceDescription,
  validateOwnerDiscordIds,
  DESCRIPTION_MAX,
  NAME_PATTERN_SOURCE,
  INTERVAL_MIN,
  INTERVAL_MAX,
  GRACE_MIN,
  GRACE_MAX,
} from '@/core/registration'

const DESC = '負責收單的後端服務'

describe('validateServiceRegistration', () => {
  it('接受 kebab-case 名稱並去除前後空白', () => {
    const result = validateServiceRegistration({ name: '  my-service-2  ', description: DESC })
    expect(result).toEqual({
      ok: true,
      value: { name: 'my-service-2', description: DESC, ownerDiscordIds: [] },
    })
  })

  it.each([
    ['空字串', ''],
    ['只有空白', '   '],
    ['大寫', 'MyService'],
    ['底線', 'my_service'],
    ['空白在中間', 'my service'],
    ['連字號開頭', '-service'],
    ['連字號結尾', 'service-'],
    ['非 ASCII', '我的服務'],
    ['單一字元', 'a'],
  ])('拒絕%s', (_label, name) => {
    const result = validateServiceRegistration({ name, description: DESC })
    expect(result.ok).toBe(false)
  })

  it('拒絕超過 64 字元的名稱', () => {
    expect(validateServiceRegistration({ name: 'a'.repeat(65), description: DESC }).ok).toBe(false)
    expect(validateServiceRegistration({ name: 'a'.repeat(64), description: DESC }).ok).toBe(true)
  })

  it('非字串輸入不會拋例外', () => {
    expect(validateServiceRegistration({ name: undefined, description: undefined }).ok).toBe(false)
    expect(validateServiceRegistration({}).ok).toBe(false)
  })

  it('名稱與說明的錯誤一起回報', () => {
    const result = validateServiceRegistration({ name: 'Bad Name', description: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toHaveLength(2)
  })
})

describe('validateServiceDescription', () => {
  it('空字串與純空白回報必填', () => {
    for (const raw of ['', '   ']) {
      const result = validateServiceDescription(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors[0]).toContain('必填')
    }
  })

  it('前後空白被 trim', () => {
    expect(validateServiceDescription('  說明  ')).toEqual({ ok: true, value: '說明' })
  })

  it('邊界：1000 字通過、1001 字超長', () => {
    expect(validateServiceDescription('a'.repeat(DESCRIPTION_MAX)).ok).toBe(true)
    const over = validateServiceDescription('a'.repeat(DESCRIPTION_MAX + 1))
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.errors[0]).toContain('1000')
  })
})

describe('validateHeartbeatRegistration', () => {
  const valid = { name: 'daily-test', intervalSeconds: '86400', graceSeconds: '3600' }

  it('接受表單送來的字串數字並轉成整數', () => {
    const result = validateHeartbeatRegistration(valid)
    expect(result).toEqual({
      ok: true,
      value: { name: 'daily-test', intervalSeconds: 86_400, graceSeconds: 3_600 },
    })
  })

  it('允許寬限期為 0', () => {
    const result = validateHeartbeatRegistration({ ...valid, graceSeconds: '0' })
    expect(result.ok).toBe(true)
  })

  it('拒絕小於下限的間隔', () => {
    expect(validateHeartbeatRegistration({ ...valid, intervalSeconds: '59' }).ok).toBe(false)
    expect(validateHeartbeatRegistration({ ...valid, intervalSeconds: '60' }).ok).toBe(true)
  })

  it('拒絕非整數與空值', () => {
    for (const intervalSeconds of ['', '  ', 'abc', '86400.5', 'NaN']) {
      expect(validateHeartbeatRegistration({ ...valid, intervalSeconds }).ok).toBe(false)
    }
  })

  it('拒絕負的寬限期', () => {
    expect(validateHeartbeatRegistration({ ...valid, graceSeconds: '-1' }).ok).toBe(false)
  })

  it('一次回報所有欄位的錯誤，而不是只回第一個', () => {
    const result = validateHeartbeatRegistration({
      name: 'BAD_NAME',
      intervalSeconds: '0',
      graceSeconds: '-5',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toHaveLength(3)
  })
})

describe('NAME_PATTERN_SOURCE（表單 <input pattern> 與後端驗證同源）', () => {
  // HTML 的 pattern 屬性隱含頭尾錨定，瀏覽器端等價於這個 RegExp
  const browserEquivalent = new RegExp(`^(?:${NAME_PATTERN_SOURCE})$`)

  it.each([
    'my-service',
    'a1',
    'svc-2026-b',
    'MyService',
    'my_service',
    'my service',
    '-svc',
    'svc-',
    '我的服務',
  ])('瀏覽器端與後端對 %s 的判定一致', (name) => {
    const browserAccepts = browserEquivalent.test(name)
    const serverAccepts = validateServiceRegistration({ name, description: DESC }).ok
    // 長度規則另計，這裡只比對字元規則：兩者對同一個名稱不能一個放行一個擋下
    expect(browserAccepts).toBe(serverAccepts)
  })

  it('門檻常數是後端實際採用的邊界', () => {
    const at = (intervalSeconds: number, graceSeconds: number) =>
      validateHeartbeatRegistration({ name: 'daily', intervalSeconds, graceSeconds }).ok

    expect(at(INTERVAL_MIN, GRACE_MIN)).toBe(true)
    expect(at(INTERVAL_MAX, GRACE_MAX)).toBe(true)
    expect(at(INTERVAL_MIN - 1, GRACE_MIN)).toBe(false)
    expect(at(INTERVAL_MAX + 1, GRACE_MIN)).toBe(false)
    expect(at(INTERVAL_MIN, GRACE_MIN - 1)).toBe(false)
    expect(at(INTERVAL_MIN, GRACE_MAX + 1)).toBe(false)
  })
})

describe('validateOwnerDiscordIds', () => {
  const A = '123456789012345678'
  const B = '234567890123456789'
  const C = '12345678901234567'
  it.each([
    ['空字串', '', []],
    ['只有空白', '   ', []],
    ['undefined', undefined, []],
    ['17 位', C, [C]],
    ['20 位', '12345678901234567890', ['12345678901234567890']],
    ['前後空白會 trim', `  ${A}  `, [A]],
    ['逗號', `${A},${B}`, [A, B]],
    ['全形逗號', `${A}，${B}`, [A, B]],
    ['頓號', `${A}、${B}`, [A, B]],
    ['空白', `${A} ${B}`, [A, B]],
    ['換行', `${A}\n${B}\r\n${C}`, [A, B, C]],
    ['混合分隔與多餘分隔符', ` ${A} ,, ${B}；`.replace('；', ''), [A, B]],
    ['去重保留首次順序', `${B}, ${A}, ${B}, ${A}`, [B, A]],
  ])('接受：%s', (_label, raw, expected) => {
    expect(validateOwnerDiscordIds(raw)).toEqual({ ok: true, value: expected })
  })

  it.each([
    ['16 位', '1234567890123456'],
    ['21 位', '123456789012345678901'],
    ['含非數字', '12345678901234567a'],
    ['含 @ 與角括號', '<@123456789012345678>'],
  ])('拒絕：%s', (_label, raw) => {
    const result = validateOwnerDiscordIds(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/Discord/)
      expect(result.errors[0]).toContain(raw)
    }
  })

  it('多個值中只有部分不合法：錯誤訊息指出不合法的值', () => {
    const result = validateOwnerDiscordIds(`${A}, abc, ${B}, 99`)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toContain('abc')
      expect(result.errors[0]).toContain('99')
      expect(result.errors[0]).not.toContain(A)
    }
  })

  it('最多 10 個：10 個通過、11 個拒絕', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `1000000000000000${i}`)
    expect(validateOwnerDiscordIds(ids.slice(0, 10).join(','))).toEqual({
      ok: true,
      value: ids.slice(0, 10),
    })
    const over = validateOwnerDiscordIds(ids.join(','))
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.errors[0]).toMatch(/10/)
  })

  it('去重後才計算上限', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `1000000000000000${i}`)
    expect(validateOwnerDiscordIds([...ids, ...ids].join(',')).ok).toBe(true)
  })

  it('validateServiceRegistration 帶入並驗證 ownerDiscordIds', () => {
    const ok = validateServiceRegistration({
      name: 'svc-x',
      description: DESC,
      ownerDiscordIds: ` ${A}, ${B} `,
    })
    expect(ok).toEqual({
      ok: true,
      value: { name: 'svc-x', description: DESC, ownerDiscordIds: [A, B] },
    })
    expect(validateServiceRegistration({ name: 'svc-x', description: DESC }).ok).toBe(true)
    expect(
      validateServiceRegistration({ name: 'svc-x', description: DESC, ownerDiscordIds: 'abc' }).ok,
    ).toBe(false)
  })
})
