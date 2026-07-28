import { describe, it, expect } from 'vitest'
import { parseIssueFilters } from '@/web/queries'

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
