import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { dockerOsvRunner, imageScanEnv, scanImages, type ImageScanRunner } from '../../scripts/security/lib/image-scan'
import type { ScanTarget } from '@/core/security/collect/images'

const FX = path.join(__dirname, '../core/security/collect/fixtures')
const caddy = JSON.parse(fs.readFileSync(path.join(FX, 'osv-caddy.json'), 'utf8'))
const D = (c: string) => `sha256:${c.repeat(64)}`
const target = (image: string, c: string | null, containers = ['a']): ScanTarget => ({
  image, digest: c ? D(c) : null, ref: c ? `${image}@${D(c)}` : null, containers,
})

describe('scanImages', () => {
  it('ref 為 null：不呼叫 runner，error 為「無 registry digest」', () => {
    const run = vi.fn<ImageScanRunner>()
    const [r] = scanImages([target('local/app', null)], run)
    expect(run).not.toHaveBeenCalled()
    expect(r).toEqual({ image: 'local/app', digest: null, containers: ['a'], error: '無 registry digest' })
  })

  it('target 帶 error：不呼叫 runner，直接帶出該 error', () => {
    const run = vi.fn<ImageScanRunner>()
    const [r] = scanImages([{ image: 'unknown', digest: null, ref: null, containers: ['unknown-x'], error: '無法查詢容器' }], run)
    expect(run).not.toHaveBeenCalled()
    expect(r).toEqual({ image: 'unknown', digest: null, containers: ['unknown-x'], error: '無法查詢容器' })
  })

  it('runner 失敗：error 為 runner 的 reason', () => {
    const [r] = scanImages([target('x/y', 'a')], () => ({ ok: false, reason: '逾時' }))
    expect(r).toEqual({ image: 'x/y', digest: D('a'), containers: ['a'], error: '逾時' })
    expect(r).not.toHaveProperty('counts')
  })

  it('解析失敗：error 為「osv 輸出無法解析」', () => {
    const [r] = scanImages([target('x/y', 'a')], () => ({ ok: true, json: { nope: 1 } }))
    expect(r.error).toBe('osv 輸出無法解析')
  })

  it('成功：填 counts 與 packages，無 error', () => {
    const [r] = scanImages([target('caddy', 'c', ['caddy'])], () => ({ ok: true, json: caddy }))
    expect(r.error).toBeUndefined()
    expect(r.counts!.critical).toBeGreaterThan(0)
    expect(Array.isArray(r.packages)).toBe(true)
    expect(r.containers).toEqual(['caddy'])
  })

  it('runner 呼叫次數等於有 ref 的 target 數，且傳入 ref', () => {
    const run = vi.fn<ImageScanRunner>(() => ({ ok: false, reason: 'x' }))
    scanImages([target('a/a', 'a'), target('b/b', null), target('c/c', 'c')], run)
    expect(run.mock.calls.map((c) => c[0])).toEqual([`a/a@${D('a')}`, `c/c@${D('c')}`])
  })
})

describe('imageScanEnv', () => {
  const src: NodeJS.ProcessEnv = {
    PATH: '/bin', HOME: '/home/r', DOCKER_CONFIG: '/dc',
    CLOUDSDK_CONFIG: '/gc', CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/cred', GOOGLE_APPLICATION_CREDENTIALS: '/adc',
    BEACON_SECRET: 's', ANTHROPIC_API_KEY: 'k', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't', GCP_PROJECT: 'p',
  }

  it('docker：帶 PATH／HOME／DOCKER_CONFIG 與 gcloud 認證變數，不帶秘密', () => {
    const e = imageScanEnv(src, 'docker')
    expect(e).toMatchObject({
      PATH: '/bin', HOME: '/home/r', DOCKER_CONFIG: '/dc',
      CLOUDSDK_CONFIG: '/gc', CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/cred', GOOGLE_APPLICATION_CREDENTIALS: '/adc',
    })
    for (const k of ['BEACON_SECRET', 'ANTHROPIC_API_KEY', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'GCP_PROJECT']) expect(e).not.toHaveProperty(k)
  })

  it('osv：只有 PATH／HOME／DOCKER_CONFIG，不帶 gcloud 認證也不帶秘密', () => {
    const e = imageScanEnv(src, 'osv')
    expect(Object.keys(e).sort()).toEqual(['DOCKER_CONFIG', 'HOME', 'PATH'])
  })

  it('來源缺值就不帶該鍵', () => {
    expect(imageScanEnv({ PATH: '/bin' }, 'docker')).toEqual({ PATH: '/bin' })
  })
})

describe('dockerOsvRunner：osv-scanner 不存在（安裝 step 失敗、OSV_SCANNER_BIN 未設）', () => {
  it('每個映像檔得到 error 而不是丟例外', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osvbin-'))
    try {
      const docker = path.join(dir, 'docker')
      fs.writeFileSync(docker, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const run = dockerOsvRunner({ osvBin: path.join(dir, 'no-such-osv-scanner'), timeoutMs: 10_000, env: { PATH: `${dir}:/usr/bin:/bin` } })
      const out = scanImages([target('a/a', 'a'), target('b/b', 'b')], run)
      expect(out.map((i) => i.error)).toEqual(['osv-scanner 無法執行', 'osv-scanner 無法執行'])
      expect(out.every((i) => i.counts === undefined)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
