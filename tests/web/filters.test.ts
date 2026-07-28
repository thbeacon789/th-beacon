import { describe, it, expect } from 'vitest'
import { parseIssueFilters, isUuid } from '@/web/queries'

describe('parseIssueFilters', () => {
  it('parses valid filters', () => {
    expect(parseIssueFilters({ serviceId: 'abc', severity: 'P1', status: 'open' })).toEqual({
      serviceId: 'abc',
      severity: 'P1',
      status: 'open',
    })
  })

  it('treats invalid values as unfiltered instead of throwing', () => {
    expect(parseIssueFilters({ severity: 'P9', status: 'closed' })).toEqual({})
  })

  it('ignores empty strings and array values', () => {
    expect(parseIssueFilters({ serviceId: '', severity: [] as unknown as string[], status: undefined })).toEqual({})
  })
})

describe('isUuid', () => {
  it('accepts canonical uuids and rejects everything else', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000001')).toBe(true)
    for (const bad of ['abc', '../etc', '00000000-0000-0000-0000-00000000000g', '']) {
      expect(isUuid(bad)).toBe(false)
    }
  })
})
