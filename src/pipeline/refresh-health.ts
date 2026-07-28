import { deriveHealth } from '@/core/health'
import type { HealthStatus } from '@/core/types'
import type { Store } from '@/store/contracts'

export async function refreshServiceHealth(
  store: Store,
  serviceId: string,
  now: Date,
): Promise<HealthStatus> {
  const service = await store.getService(serviceId)
  if (service === null) throw new Error(`unknown service: ${serviceId}`)
  const openIssues = await store.listOpenIssues(serviceId)
  const health = deriveHealth({
    poll: service.poll,
    openIssues,
    now,
    windowMinutes: service.healthWindowMinutes,
    failureThreshold: service.healthFailureThreshold,
  })
  if (health !== service.healthStatus) {
    await store.updateServiceHealth(serviceId, health)
  }
  return health
}
