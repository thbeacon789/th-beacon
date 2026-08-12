import { describe, it, expect } from 'vitest'
import {
  validateServiceRegistration,
  validateHeartbeatRegistration,
  NAME_PATTERN_SOURCE,
  INTERVAL_MIN,
  INTERVAL_MAX,
  GRACE_MIN,
  GRACE_MAX,
} from '@/core/registration'

describe('validateServiceRegistration', () => {
  it('接受 kebab-case 名稱並去除前後空白', () => {
    const result = validateServiceRegistration({ name: '  my-service-2  ' })
    expect(result).toEqual({ ok: true, value: { name: 'my-service-2' } })
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
    const result = validateServiceRegistration({ name })
    expect(result.ok).toBe(false)
  })

  it('拒絕超過 64 字元的名稱', () => {
    expect(validateServiceRegistration({ name: 'a'.repeat(65) }).ok).toBe(false)
    expect(validateServiceRegistration({ name: 'a'.repeat(64) }).ok).toBe(true)
  })

  it('非字串輸入不會拋例外', () => {
    expect(validateServiceRegistration({ name: undefined }).ok).toBe(false)
    expect(validateServiceRegistration({}).ok).toBe(false)
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
    const serverAccepts = validateServiceRegistration({ name }).ok
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
