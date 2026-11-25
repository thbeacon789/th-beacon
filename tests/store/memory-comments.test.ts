import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '@/store/memory'

describe('InMemoryStore 留言', () => {
  it('issue 留言依插入序回傳、欄位相符、不同 issue 互不混', async () => {
    const s = new InMemoryStore()
    const a = await s.addIssueComment({ issueId: 'i1', author: 'a@x.com', body: '第一則', kind: 'comment' })
    const b = await s.addIssueComment({ issueId: 'i1', author: 'b@x.com', body: '第二則', kind: 'resolve' })
    await s.addIssueComment({ issueId: 'i2', author: 'c@x.com', body: '別的', kind: 'comment' })
    const list = await s.listIssueComments('i1')
    expect(list.map((c) => c.id)).toEqual([a.id, b.id])
    expect(list[0]).toMatchObject({ author: 'a@x.com', body: '第一則', kind: 'comment' })
    expect(list[1]).toMatchObject({ author: 'b@x.com', body: '第二則', kind: 'resolve' })
    expect(typeof list[0].createdAt).toBe('string')
    expect(await s.listIssueComments('none')).toEqual([])
  })

  it('資安留言：空陣列回 []；多 id 只回指定且帶 findingId', async () => {
    const s = new InMemoryStore()
    await s.addSecurityFindingComment({ findingId: 'f1', author: 'a', body: '1', kind: 'comment' })
    await s.addSecurityFindingComment({ findingId: 'f2', author: 'a', body: '2', kind: 'resolve' })
    await s.addSecurityFindingComment({ findingId: 'f3', author: 'a', body: '3', kind: 'comment' })
    expect(await s.listSecurityFindingComments([])).toEqual([])
    const list = await s.listSecurityFindingComments(['f1', 'f3'])
    expect(list.map((c) => [c.findingId, c.body])).toEqual([['f1', '1'], ['f3', '3']])
  })
})
