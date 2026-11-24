import { describe, it, expect } from 'vitest'
import { planImageScans } from '@/core/security/collect/images'
import type { ImageEntry } from '@/core/security/types'

const H = (c: string) => c.repeat(64)
const APP = 'asia-east1-docker.pkg.dev/altinvest/backend/app'

const entry = (over: Partial<ImageEntry>): ImageEntry => ({
  container: 'api',
  configImage: `${APP}:abc`,
  imageId: `sha256:${H('1')}`,
  repoDigests: [`${APP}@sha256:${H('a')}`],
  ...over,
})

describe('planImageScans', () => {
  it('同 imageId 的容器合併為一個 target', () => {
    const t = planImageScans([entry({ container: 'worker' }), entry({ container: 'api' })])
    expect(t).toEqual([
      { image: APP, digest: `sha256:${H('a')}`, ref: `${APP}@sha256:${H('a')}`, containers: ['api', 'worker'] },
    ])
  })

  it('Docker Hub 短名照用', () => {
    const t = planImageScans([
      entry({ container: 'proxy', configImage: 'caddy:2-alpine', imageId: `sha256:${H('2')}`, repoDigests: [`caddy@sha256:${H('b')}`] }),
    ])
    expect(t[0].image).toBe('caddy')
    expect(t[0].ref).toBe(`caddy@sha256:${H('b')}`)
  })

  it('多筆 repoDigests 取與 configImage 同 repository 者，都不同取第一筆', () => {
    const t = planImageScans([
      entry({ repoDigests: [`other/x@sha256:${H('c')}`, `${APP}@sha256:${H('d')}`] }),
      entry({ container: 'z', imageId: `sha256:${H('3')}`, configImage: 'nomatch:1', repoDigests: [`first/y@sha256:${H('e')}`, `second/z@sha256:${H('f')}`] }),
    ])
    const byContainer = Object.fromEntries(t.map((x) => [x.containers[0], x]))
    expect(byContainer.api.ref).toBe(`${APP}@sha256:${H('d')}`)
    expect(byContainer.z.ref).toBe(`first/y@sha256:${H('e')}`)
  })

  it('registry 帶埠號時只去掉最後的 tag', () => {
    const t = planImageScans([
      entry({ configImage: 'host:5000/repo/app:1.0', repoDigests: [`other@sha256:${H('c')}`, `host:5000/repo/app@sha256:${H('d')}`] }),
    ])
    expect(t[0].ref).toBe(`host:5000/repo/app@sha256:${H('d')}`)
  })

  it('沒有 repoDigests → digest 與 ref 為 null', () => {
    const t = planImageScans([entry({ configImage: 'local-build:1', repoDigests: [] })])
    expect(t).toEqual([{ image: 'local-build', digest: null, ref: null, containers: ['api'] }])
  })

  it('不符樣式的 digest 一律忽略', () => {
    const bad = [`${APP}@sha256:${'A'.repeat(64)}`, `${APP}@sha256:abc`, `-x@sha256:${H('a')}`, `a b@sha256:${H('a')}`, `${APP}@sha256:${H('a')}\n`]
    const t = planImageScans([entry({ repoDigests: bad })])
    expect(t[0].ref).toBeNull()
    expect(t[0].digest).toBeNull()
  })

  it('依 image 升冪排序', () => {
    const t = planImageScans([
      entry({ container: 'b', imageId: `sha256:${H('2')}`, configImage: 'zzz:1', repoDigests: [`zzz@sha256:${H('a')}`] }),
      entry({ container: 'a', imageId: `sha256:${H('3')}`, configImage: 'aaa:1', repoDigests: [`aaa@sha256:${H('b')}`] }),
    ])
    expect(t.map((x) => x.image)).toEqual(['aaa', 'zzz'])
  })
})

describe('planImageScans 無法查詢的容器', () => {
  const unresolved = (container: string): ImageEntry => ({ container, configImage: 'unknown', imageId: '', repoDigests: [] })
  it('每個哨兵各自一個 target，帶 error 且 ref 為 null，不與其他容器合併', () => {
    const t = planImageScans([unresolved('unknown-aaa'), unresolved('unknown-bbb'), entry({})])
    const bad = t.filter((x) => x.error !== undefined)
    expect(bad).toEqual([
      { image: 'unknown', digest: null, ref: null, containers: ['unknown-aaa'], error: '無法查詢容器' },
      { image: 'unknown', digest: null, ref: null, containers: ['unknown-bbb'], error: '無法查詢容器' },
    ])
    expect(t).toHaveLength(3)
  })
})
