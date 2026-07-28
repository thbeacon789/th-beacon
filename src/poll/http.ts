import type { HttpGet } from '@/poll/poll-service'

export const httpGet: HttpGet = async (url, timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    const bodyText = await response.text()
    return { ok: true, status: response.status, bodyText }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : 'fetch_failed' }
  } finally {
    clearTimeout(timer)
  }
}
