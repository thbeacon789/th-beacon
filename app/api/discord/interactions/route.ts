import { after } from 'next/server'
import { createInteractionResponder } from '@/notify/discord-bot'
import { handleInteraction } from '@/notify/handle-interaction'
import { createServerNotifyDeps, createServerStore, getDiscordInteractionConfig } from '@/store/server'

export const maxDuration = 300

export async function POST(request: Request): Promise<Response> {
  const config = getDiscordInteractionConfig()
  if (config === null) return Response.json({ error: 'discord interactions not configured' }, { status: 503 })
  const rawBody = await request.text()
  const res = await handleInteraction(
    createServerStore(),
    createServerNotifyDeps({ budget: null }).bot ?? null,
    createInteractionResponder({ applicationId: config.applicationId }),
    config,
    {
      rawBody,
      signature: request.headers.get('x-signature-ed25519'),
      timestamp: request.headers.get('x-signature-timestamp'),
    },
    new Date(),
  )
  if (res.after) after(res.after)
  return Response.json(res.body, { status: res.status })
}
