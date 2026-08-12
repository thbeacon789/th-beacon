import { describe, it, expect } from 'vitest'
import {
  validateServiceRegistration,
  validateHeartbeatRegistration,
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
