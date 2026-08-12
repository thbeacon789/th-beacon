'use server'

import { randomBytes } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/web/supabase-server'
import { createServerStore } from '@/store/server'
import { validateServiceRegistration, validateHeartbeatRegistration } from '@/core/registration'
import { isUuid } from '@/web/queries'

export type RegistrationState =
  | { status: 'idle' }
  | { status: 'error'; errors: string[] }
  // secret 只在這一刻存在於畫面上：DB 存的是明文，但頁面刻意不再回讀，
  // 忘了就走 rotate 換一把，避免金鑰長期停留在任何人的瀏覽器分頁裡。
  | { status: 'created'; serviceName: string; heartbeatName: string | null; secret: string }
  | { status: 'rotated'; serviceName: string; secret: string }
  | { status: 'heartbeat-added'; serviceName: string; heartbeatName: string }

function newSecret(): string {
  return randomBytes(32).toString('hex')
}

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 建立服務，並可選擇同時登記第一個心跳。
 * 兩者合併成一次操作是刻意的——分兩步最常見的失誤就是建完服務忘了登記心跳，
 * CI 接上去只會一直收 404。
 */
export async function registerServiceAction(
  _prev: RegistrationState,
  form: FormData,
): Promise<RegistrationState> {
  await requireUser()

  const serviceInput = validateServiceRegistration({ name: field(form, 'serviceName') })
  const wantsHeartbeat = field(form, 'withHeartbeat') === 'on'
  const heartbeatInput = wantsHeartbeat
    ? validateHeartbeatRegistration({
        name: field(form, 'heartbeatName'),
        intervalSeconds: field(form, 'intervalSeconds'),
        graceSeconds: field(form, 'graceSeconds'),
      })
    : null

  const errors = [
    ...(serviceInput.ok ? [] : serviceInput.errors),
    ...(heartbeatInput === null || heartbeatInput.ok ? [] : heartbeatInput.errors),
  ]
  if (errors.length > 0) return { status: 'error', errors }
  if (!serviceInput.ok) return { status: 'error', errors: serviceInput.errors }

  const store = createServerStore()
  const secret = newSecret()
  const service = await store.createService(serviceInput.value.name, secret)
  if (service === null) {
    return { status: 'error', errors: [`服務名稱「${serviceInput.value.name}」已經存在`] }
  }

  let heartbeatName: string | null = null
  if (heartbeatInput !== null && heartbeatInput.ok) {
    const heartbeat = await store.createHeartbeat(service.id, heartbeatInput.value)
    // 服務已經建起來了，心跳這步失敗不該把整筆吞掉——回報部分成功，讓使用者補登記。
    if (heartbeat === null) {
      revalidatePath('/services')
      return {
        status: 'error',
        errors: [`服務已建立，但心跳名稱「${heartbeatInput.value.name}」重複，請在下方單獨登記`],
      }
    }
    heartbeatName = heartbeat.name
  }

  revalidatePath('/services')
  revalidatePath('/')
  return { status: 'created', serviceName: service.name, heartbeatName, secret }
}

/** 對既有服務補登記心跳 */
export async function registerHeartbeatAction(
  _prev: RegistrationState,
  form: FormData,
): Promise<RegistrationState> {
  await requireUser()

  const serviceId = field(form, 'serviceId')
  const serviceName = field(form, 'serviceName')
  if (!isUuid(serviceId)) return { status: 'error', errors: ['服務不存在'] }

  const input = validateHeartbeatRegistration({
    name: field(form, 'heartbeatName'),
    intervalSeconds: field(form, 'intervalSeconds'),
    graceSeconds: field(form, 'graceSeconds'),
  })
  if (!input.ok) return { status: 'error', errors: input.errors }

  const heartbeat = await createServerStore().createHeartbeat(serviceId, input.value)
  if (heartbeat === null) {
    return { status: 'error', errors: [`心跳名稱「${input.value.name}」在這個服務下已經存在`] }
  }

  revalidatePath('/services')
  revalidatePath('/')
  return { status: 'heartbeat-added', serviceName, heartbeatName: heartbeat.name }
}

/** 重新產生金鑰。舊金鑰即刻失效——CI 未同步更新前，該服務的回報全數 401。 */
export async function rotateSecretAction(
  _prev: RegistrationState,
  form: FormData,
): Promise<RegistrationState> {
  await requireUser()

  const serviceId = field(form, 'serviceId')
  const serviceName = field(form, 'serviceName')
  if (!isUuid(serviceId)) return { status: 'error', errors: ['服務不存在'] }

  const secret = newSecret()
  const ok = await createServerStore().rotateWebhookSecret(serviceId, secret)
  if (!ok) return { status: 'error', errors: ['服務不存在'] }

  revalidatePath('/services')
  return { status: 'rotated', serviceName, secret }
}
