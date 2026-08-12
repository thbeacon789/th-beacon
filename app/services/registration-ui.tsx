'use client'

import { useActionState, useState } from 'react'
import { SubmitButton } from '@/web/submit-button'
import {
  registerServiceAction,
  registerHeartbeatAction,
  rotateSecretAction,
  type RegistrationState,
} from './actions'

const IDLE: RegistrationState = { status: 'idle' }

const DEFAULT_INTERVAL = 86400
const DEFAULT_GRACE = 7200

function ErrorList({ state }: { state: RegistrationState }) {
  if (state.status !== 'error') return null
  return (
    <ul className="reg-errors" role="alert">
      {state.errors.map((error) => (
        <li key={error}>{error}</li>
      ))}
    </ul>
  )
}

/**
 * 金鑰只在 action 回傳的那一次渲染裡存在。刻意不寫進 localStorage、不放進 URL，
 * 重新整理就消失——使用者若沒存下來，正確做法是 rotate 換一把新的。
 */
function SecretPanel({ secret, title, hint }: { secret: string; title: string; hint: string }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setCopyFailed(false)
    } catch {
      // 非 https（或使用者拒絕權限）時 clipboard API 不可用——不靜默失敗，
      // 明講一聲讓使用者自己選取複製，否則他會以為已經複製到了。
      setCopyFailed(true)
    }
  }

  return (
    <div className="secret-panel" role="status">
      <strong className="secret-title">{title}</strong>
      <p className="secret-warn">⚠ 這把金鑰只顯示這一次，離開或重新整理就看不到了。</p>
      <div className="secret-value">
        <code className="mono">{secret}</code>
        <button type="button" onClick={copy}>
          {copied ? '已複製' : '複製'}
        </button>
      </div>
      {copyFailed && (
        <p className="hint">無法自動複製（瀏覽器不允許），請手動選取上方文字。</p>
      )}
      <p className="hint">{hint}</p>
    </div>
  )
}

export function RegisterServiceForm() {
  const [state, action] = useActionState(registerServiceAction, IDLE)
  const [withHeartbeat, setWithHeartbeat] = useState(true)

  return (
    <div className="reg-block">
      <form action={action} className="reg-form">
        <label>
          服務名稱
          <input
            name="serviceName"
            required
            placeholder="my-service"
            pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
            title="小寫英數與連字號，須以英數開頭結尾"
          />
          <span className="hint">小寫英數與連字號。這個值就是 CI 要送的 X-Beacon-Service。</span>
        </label>

        <label className="reg-check">
          <input
            type="checkbox"
            name="withHeartbeat"
            checked={withHeartbeat}
            onChange={(event) => setWithHeartbeat(event.target.checked)}
          />
          同時登記一個心跳（建議：沒登記心跳的話 CI 回報會收 404）
        </label>

        {withHeartbeat && (
          <div className="reg-nested">
            <label>
              心跳名稱
              <input
                name="heartbeatName"
                required={withHeartbeat}
                placeholder="daily-test"
                pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
                title="小寫英數與連字號，須以英數開頭結尾"
              />
            </label>
            <label>
              回報間隔（秒）
              <input
                type="number"
                name="intervalSeconds"
                defaultValue={DEFAULT_INTERVAL}
                min={60}
                max={2592000}
                required={withHeartbeat}
              />
              <span className="hint">CI 實際排程頻率。每天一次 = 86400</span>
            </label>
            <label>
              寬限期（秒）
              <input
                type="number"
                name="graceSeconds"
                defaultValue={DEFAULT_GRACE}
                min={0}
                max={604800}
                required={withHeartbeat}
              />
              <span className="hint">CI 排隊／重跑的緩衝。超過 間隔＋寬限 才算逾期</span>
            </label>
          </div>
        )}

        <ErrorList state={state} />
        <SubmitButton pendingLabel="登記中…">登記服務</SubmitButton>
      </form>

      {state.status === 'created' && (
        <SecretPanel
          secret={state.secret}
          title={`「${state.serviceName}」已登記${state.heartbeatName === null ? '' : `，心跳「${state.heartbeatName}」已就緒`}`}
          hint={
            state.heartbeatName === null
              ? '請把金鑰存進該專案 CI 的 secrets（BEACON_SECRET）。接心跳前記得先在下方登記心跳名稱。'
              : '請把金鑰存進該專案 CI 的 secrets（BEACON_SECRET），接著照下方的接入步驟設定 CI。'
          }
        />
      )}
    </div>
  )
}

export function AddHeartbeatForm({
  serviceId,
  serviceName,
}: {
  serviceId: string
  serviceName: string
}) {
  const [state, action] = useActionState(registerHeartbeatAction, IDLE)

  return (
    <form action={action} className="reg-form reg-form-inline">
      <input type="hidden" name="serviceId" value={serviceId} />
      <input type="hidden" name="serviceName" value={serviceName} />
      <label>
        心跳名稱
        <input
          name="heartbeatName"
          required
          placeholder="daily-test"
          pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
          title="小寫英數與連字號，須以英數開頭結尾"
        />
      </label>
      <label>
        間隔（秒）
        <input
          type="number"
          name="intervalSeconds"
          defaultValue={DEFAULT_INTERVAL}
          min={60}
          max={2592000}
          required
        />
      </label>
      <label>
        寬限（秒）
        <input
          type="number"
          name="graceSeconds"
          defaultValue={DEFAULT_GRACE}
          min={0}
          max={604800}
          required
        />
      </label>
      <SubmitButton pendingLabel="新增中…">新增心跳</SubmitButton>
      <ErrorList state={state} />
      {state.status === 'heartbeat-added' && (
        <p className="reg-ok" role="status">
          心跳「{state.heartbeatName}」已登記，CI 現在可以開始回報了。
        </p>
      )}
    </form>
  )
}

export function RotateSecretForm({
  serviceId,
  serviceName,
}: {
  serviceId: string
  serviceName: string
}) {
  const [state, action] = useActionState(rotateSecretAction, IDLE)
  const [armed, setArmed] = useState(false)

  return (
    <div className="reg-rotate">
      {!armed ? (
        <button type="button" className="btn-danger" onClick={() => setArmed(true)}>
          重新產生金鑰
        </button>
      ) : (
        <form action={action} className="reg-form-inline">
          <input type="hidden" name="serviceId" value={serviceId} />
          <input type="hidden" name="serviceName" value={serviceName} />
          <span className="reg-warn">
            舊金鑰會立刻失效，「{serviceName}」的 CI 在更新 secret 前會全部收到 401。
          </span>
          <SubmitButton pendingLabel="產生中…">確定重新產生</SubmitButton>
          <button type="button" onClick={() => setArmed(false)}>
            取消
          </button>
        </form>
      )}
      <ErrorList state={state} />
      {state.status === 'rotated' && (
        <SecretPanel
          secret={state.secret}
          title={`「${state.serviceName}」的新金鑰`}
          hint="立刻更新該專案 CI 的 BEACON_SECRET，否則下一次回報就會失敗。"
        />
      )}
    </div>
  )
}
