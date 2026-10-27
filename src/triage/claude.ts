import type Anthropic from '@anthropic-ai/sdk'
import { AI_TRIAGE_MODEL, TRIAGE_OUTPUT_SCHEMA, parseTriageOutput } from '@/core/ai-triage'
import { DIAGNOSIS_ERROR_LIMIT, truncateText, type HeartbeatDiagnosis } from '@/core/heartbeat'

export type TriageCallResult =
  | { ok: true; diagnosis: HeartbeatDiagnosis; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; error: string }

export type Triager = (prompt: { system: string; user: string }) => Promise<TriageCallResult>

const DEFAULT_TIMEOUT_MS = 25_000
const MAX_TOKENS = 1024

function fail(message: string): TriageCallResult {
  return { ok: false, error: truncateText(message, DIAGNOSIS_ERROR_LIMIT) }
}

/** 錯誤訊息只取 name + HTTP status + 截斷 message，並遮蔽疑似金鑰／token 的字串（避免寫進 DB／Discord）。 */
function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : 'Error'
  const status = (err as { status?: unknown } | null)?.status
  const raw = err instanceof Error ? err.message : String(err)
  const safe = raw.replace(/sk-ant[\w-]*/gi, '[redacted]').replace(/Bearer\s+\S+/gi, '[redacted]')
  return `${name}${typeof status === 'number' ? ` ${status}` : ''}: ${safe}`
}

class TriageTimeoutError extends Error {
  override name = 'TriageTimeoutError'
}

export function createClaudeTriager(client: Anthropic, opts: { timeoutMs?: number } = {}): Triager {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return async (prompt) => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // fetch 不一定尊重 abort，所以另用 race 保證逾時一定回來。
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new TriageTimeoutError(`timeout after ${timeoutMs}ms`))
        }, timeoutMs)
      })
      const message = await Promise.race([
        client.messages.create(
          {
            model: AI_TRIAGE_MODEL,
            max_tokens: MAX_TOKENS,
            system: prompt.system,
            messages: [{ role: 'user', content: prompt.user }],
            output_config: { format: { type: 'json_schema', schema: TRIAGE_OUTPUT_SCHEMA } },
          },
          { signal: controller.signal, timeout: timeoutMs, maxRetries: 0 },
        ),
        timeout,
      ])
      if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') {
        return fail(`stop_reason ${message.stop_reason}`)
      }
      const block = message.content.find((b) => b.type === 'text')
      if (block === undefined || block.type !== 'text') return fail('no text block in response')
      let json: unknown
      try {
        json = JSON.parse(block.text)
      } catch {
        return fail('response is not valid JSON')
      }
      const parsed = parseTriageOutput(json)
      if (!parsed.ok) return fail(`invalid output: ${parsed.reason}`)
      const usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens }
      console.log(`[ai-triage] usage input=${usage.inputTokens} output=${usage.outputTokens} model=${AI_TRIAGE_MODEL}`)
      return { ok: true, diagnosis: { ...parsed.value, model: AI_TRIAGE_MODEL }, usage }
    } catch (err) {
      return fail(describeError(err))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
