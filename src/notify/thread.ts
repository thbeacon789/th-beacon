import { THREAD_NAME_MAX, type DiscordBot, type BotPostResult } from '@/notify/discord-bot'
import type { DiscordMessage, DiscordReplyMessage } from '@/notify/message'

/**
 * 把確認／解決訊息發到以根訊息開出的討論串（thread id = 根訊息 id，Discord 文件載明，故不必另存）。
 * 流程：直接發到 thread → 失敗則開 thread（已存在時 Discord 回 400，忽略）再發一次 →
 * 仍失敗退回在頻道以回覆（message_reference）發送，確保訊息不遺失。永不 throw。
 */
export async function postInThread(
  bot: DiscordBot,
  root: { channelId: string; messageId: string; payload: DiscordMessage },
  build: (replyTo?: string) => DiscordReplyMessage,
  label = 'postInThread', // log 前綴：呼叫端傳入，才分得出是哪條流程的失敗
): Promise<BotPostResult> {
  const inThread = build()
  let result = await bot.postTo(root.messageId, inThread)
  if (!result.ok) {
    const title = root.payload.embeds[0]?.title ?? ''
    const started = await bot.startThread(root.channelId, root.messageId, title.slice(0, THREAD_NAME_MAX))
    if (!started.ok) console.error(`${label}: start thread failed: ${started.reason}`)
    result = await bot.postTo(root.messageId, inThread)
  }
  if (!result.ok) {
    console.error(`${label}: thread post failed (${result.reason}), fallback to channel reply`)
    result = await bot.postTo(root.channelId, build(root.messageId))
  }
  return result
}
