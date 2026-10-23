# E2E 失敗 AI 判讀 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CI 的 e2e 失敗後先呼叫一次 Claude API 判讀 log，產出四項：分類（env／app）、嚴重度、原因、修正建議。th-beacon 依判讀結果拆分 issue、決定 Discord 顏色與內容。

**Architecture:**
- CI 端用一支共用 bash 腳本 `scripts/diagnose-e2e-failure.sh` 讀 log、遮蔽秘密，用 structured outputs 呼叫 Messages API，產出 `diagnosis.json`。
- 擴充後的 `heartbeat-to-beacon.sh` 把 `diagnosis.json` 夾帶進心跳 payload。
- th-beacon 端：
  - 解析選填的 `diagnosis`／`diagnosisError`。
  - env 類改用 `test_failure_env` 另立 issue。
  - event 帶的 severity 取代規則表判級。
  - 通知門檻降到 P2。
  - Discord 顏色取這一次 event 的 severity。

**Tech Stack:**
- th-beacon：Next.js App Router、TypeScript、Vitest、Supabase。
- CI 腳本：bash、curl、jq、perl。
- CI 平台：GitHub Actions。Android 跑在 ubuntu-latest，iOS 跑在自架 macOS runner。

**Spec:** `docs/superpowers/specs/2026-10-23-e2e-failure-ai-triage-design.md`

## Global Constraints

**Claude API 呼叫**
- 模型：`claude-sonnet-5-5`，可用環境變數 `DIAGNOSE_MODEL` 覆寫。
- 結構化輸出參數：`output_config: {"format": {"type": "json_schema", "schema": <schema>}}`。
- 不送 `temperature`、`top_p`、`top_k`，送了會回 400。
- 輸出 schema 固定為：
  - `category`：enum `env`、`app`
  - `severity`：enum `P0`、`P1`、`P2`
  - `reason`：string
  - `suggestion`：string
  - 四個欄位都 required，且 `additionalProperties: false`。
- `reason` 與 `suggestion` 一律使用繁體中文。

**長度上限（th-beacon 端截斷）**
- `reason`：500 字。
- `suggestion`：1000 字。
- `diagnosisError`：200 字。
- Discord 欄位：1000 字（沿用 `FIELD_LIMIT`）。

**認證（WIF，spec §5.5）**
- CI 不存 Anthropic API key。
- 取 GitHub OIDC JWT 時，audience 用 `https://api.anthropic.com`。
- 換 token：`POST ${ANTHROPIC_BASE_URL}/v1/oauth/token`，`grant_type` 為 `urn:ietf:params:oauth:grant-type:jwt-bearer`。
- 呼叫 Messages API 的 header 為 `authorization: Bearer <access_token>`。
- JWT 與 access token 不得寫入 stdout、log 或輸出檔。

**CI 腳本**
- log 總量上限約 150,000 bytes（`DIAGNOSE_MAX_BYTES`）。
- `curl --max-time 100`，失敗不重試。
- 腳本一律 `exit 0`。

**相容性與既有約束**
- payload 向後相容：`diagnosis` 不合法時丟棄並回 warning，絕不 422。
- `src/core/**` 必須維持純函式：禁止 I/O，禁止 `Date.now`。
- 通知門檻：`NOTIFY_MIN_SEVERITY = 'P2'`，全域生效。
- 新的 errorType 字面值為 `test_failure_env`。

**工作流程**
- 每完成一個任務就 commit，用明確路徑 `git add`，禁止 `git add -A`。
- 不 push；push 一律由使用者明確下令。
- 跨 repo 的任務在各自的 repo commit。

## Review Focus

1. **`status: "pass"` 卻帶了 `diagnosis`**：應忽略，不建 issue。→ Task 5 測試 `pass 帶 diagnosis 時忽略且 resolve 兩筆 issue`。
2. **log 含非 UTF-8 位元組**（iOS 已知會有）：腳本仍要送出合法 JSON，不能因 jq 失敗而變成 error。→ Task 6 測試 `非 UTF-8 log 仍送出合法 request`。
3. **秘密值含 regex 特殊字元**（例如密碼含 `$`、`.`、`/`、`\`）：必須逐字遮蔽。→ Task 6 測試 `含特殊字元的秘密被逐字遮蔽`。
4. **Claude 回 `stop_reason: max_tokens` 或 `refusal`**，內容可能是截斷的 JSON：應輸出 `{"error": ...}`，不可以把殘缺的 JSON 當成診斷結果。→ Task 6 測試 `stop_reason 非 end_turn 時輸出 error`。
5. **`diagnosis` 的 `reason` 是空字串、或多出未知欄位**：空字串視為不合法，丟棄並回 warning；多出的未知欄位忽略。→ Task 1 測試 `reason 空字串時丟棄` 與 `未知欄位不進入結果`。

---

## File Structure

| 檔案 | 責任 |
|---|---|
| `src/core/types.ts` | `CanonicalEvent` 新增 `severity?: Severity` |
| `src/core/heartbeat.ts` | 定義 `HeartbeatDiagnosis` 型別與長度常數；`normalizeHeartbeatFailure` 依分類分流 |
| `src/heartbeat/payload.ts` | 解析與驗證 `diagnosis`／`diagnosisError` |
| `src/pipeline/process-event.ts` | 當 event 帶 severity 時，以它取代規則表 |
| `src/notify/decision.ts` | 門檻改為 P2 |
| `src/notify/message.ts` | 新增診斷欄位、依分類調整標題 |
| `src/pipeline/process-and-notify.ts` | 改用 `event.severity ?? issue.severity` 判斷通知與顏色 |
| `src/heartbeat/handle-heartbeat.ts` | 把診斷結果往下傳；pass 時 resolve 兩筆 issue |
| `docs/api.md` | 補上新欄位的契約說明 |
| `scripts/diagnose-e2e-failure.sh`（新增） | 共用判讀腳本 |
| `scripts/heartbeat-to-beacon.sh` | 新增可選的第 5 參數 |
| `tests/scripts/*.test.ts`（新增） | 用假 HTTP server 驅動 bash 腳本 |
| Android／iOS repo | 複製兩支腳本、新增 `.github/e2e-known-env-issues.md`、修改 `e2e-prod.yml` |

---

### Task 1: payload 解析 `diagnosis`／`diagnosisError`

**Files:**
- Modify: `src/core/heartbeat.ts`（新增型別與常數）
- Modify: `src/heartbeat/payload.ts`
- Test: `tests/heartbeat/payload.test.ts`

**Interfaces:**
- Produces（`src/core/heartbeat.ts`）：
  ```ts
  export type DiagnosisCategory = 'env' | 'app'
  export interface HeartbeatDiagnosis {
    category: DiagnosisCategory
    severity: Severity
    reason: string
    suggestion: string
    model?: string
  }
  export const DIAGNOSIS_REASON_LIMIT = 500
  export const DIAGNOSIS_SUGGESTION_LIMIT = 1000
  export const DIAGNOSIS_ERROR_LIMIT = 200
  ```
- Produces（`src/heartbeat/payload.ts`）：`RawHeartbeatReport` 新增 `diagnosis?: HeartbeatDiagnosis` 與 `diagnosisError?: string`。

- [ ] **Step 1: 寫失敗測試**（`describe('diagnosis')`）
  - `合法 diagnosis 被保留`：輸入 `{name:'x', status:'fail', diagnosis:{category:'env', severity:'P2', reason:'r', suggestion:'s', model:'claude-sonnet-5-5'}}`。預期 `value.diagnosis` 完全相等，`warnings` 為 `[]`。
  - `enum 不合法時丟棄並回 warning`：`category:'flaky'`。預期 `ok: true`、`value.diagnosis` 為 `undefined`，且 `warnings` 含 `'diagnosis was rejected'`（子字串比對）。
  - `severity 不合法時丟棄`：`severity:'P3'`，預期同上。
  - `reason 空字串時丟棄`：`reason:''`，預期同上。
  - `diagnosis 不是物件時丟棄`：`diagnosis:'env'`，預期同上。
  - `未知欄位不進入結果`：diagnosis 多帶 `extra:1`。預期 `value.diagnosis` 不含 `extra`，其餘欄位保留。
  - `超長 reason 與 suggestion 被截斷`：reason 長 600、suggestion 長 1200。預期長度分別為 `DIAGNOSIS_REASON_LIMIT`、`DIAGNOSIS_SUGGESTION_LIMIT`，且結尾為 `'…'`。
  - `diagnosisError 字串被保留並截斷`：長 300。預期長度為 `DIAGNOSIS_ERROR_LIMIT`。
  - `diagnosisError 非字串時丟棄並回 warning`。
  - `舊格式（無 diagnosis）行為不變`：預期 `value` 不含 `diagnosis`、`diagnosisError` 兩個 key。

- [ ] **Step 2: 執行測試，確認失敗**
  Run：`pnpm vitest run tests/heartbeat/payload.test.ts`
  Expected：新增的 case FAIL。

- [ ] **Step 3: 實作**
  - 在 `parseHeartbeatPayload` 內以私有函式 `parseDiagnosis(raw: unknown): HeartbeatDiagnosis | null` 白名單萃取：只取 5 個欄位，`model` 選填。
  - 截斷邏輯與 `truncateRunSummary` 相同（`slice(0, limit - 1) + '…'`）。抽成 `src/core/heartbeat.ts` 的 `truncateText(text: string, limit: number): string`，並讓 `truncateRunSummary` 改用它。
  - 不合法時加 warning：`'diagnosis was rejected: <原因>'`、`'diagnosisError was rejected: must be a string'`。

- [ ] **Step 4: 執行測試，確認通過**
  Run：`pnpm vitest run tests/heartbeat/payload.test.ts tests/core/heartbeat.test.ts`
  Expected：全部 PASS。

- [ ] **Step 5: Commit**
  ```bash
  git add src/core/heartbeat.ts src/heartbeat/payload.ts tests/heartbeat/payload.test.ts
  git commit -m "feat(heartbeat): payload 解析選填的 diagnosis／diagnosisError"
  ```

---

### Task 2: 正規化依分類分流並帶出 severity

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/heartbeat.ts`
- Test: `tests/core/heartbeat.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `HeartbeatDiagnosis`、`truncateRunSummary`。
- Produces：
  - `CanonicalEvent` 新增 `severity?: Severity`。
  - `HeartbeatFailurePayload` 新增 `diagnosis?: HeartbeatDiagnosis` 與 `diagnosisError?: string`。
  - `export const TEST_FAILURE_ENV = 'test_failure_env'`。
  - `normalizeHeartbeatFailure` 簽名不變。

- [ ] **Step 1: 寫失敗測試**
  - `env 診斷 → test_failure_env 與獨立 fingerprint`：
    - 預期 `errorType === 'test_failure_env'`
    - 預期 `message === 'Test failed (env): <name>'`
    - 預期 `fingerprint === heartbeatFingerprint(serviceId, 'test_failure_env', name)`，且不等於 `test_failure` 的 fingerprint
    - 預期 `severity === diagnosis.severity`
    - 預期 `metadata.diagnosis` 等於輸入的 diagnosis
  - `app 診斷 → 沿用 test_failure，帶 severity`：預期 `errorType === 'test_failure'`、`severity === 'P0'`（輸入 P0）。
  - `無診斷 → 行為不變且無 severity`：預期 `'severity' in event === false`。
  - `diagnosisError 寫入 metadata`：預期 `errorType === 'test_failure'`、`metadata.diagnosisError === 'timeout'`、無 `severity`。
  - `metadata.summary 為截斷後的值`：輸入長 600 的 summary，預期 `metadata.summary.length === RUN_SUMMARY_LIMIT`。

- [ ] **Step 2: 執行，確認失敗**
  Run：`pnpm vitest run tests/core/heartbeat.test.ts`
  Expected：FAIL。

- [ ] **Step 3: 實作**
  - 依 Interfaces 改 `normalizeHeartbeatFailure`。
  - summary 改用 `truncateRunSummary` 的結果寫入 metadata；結果為 `null` 時不寫入。

- [ ] **Step 4: 執行 `pnpm vitest run tests/core && pnpm typecheck`**
  Expected：PASS，typecheck 無錯誤。

- [ ] **Step 5: Commit**
  ```bash
  git add src/core/types.ts src/core/heartbeat.ts tests/core/heartbeat.test.ts
  git commit -m "feat(core): 心跳失敗依 AI 分類分流 test_failure_env 並帶出 severity"
  ```

---

### Task 3: processEvent 採用 event severity

**Files:**
- Modify: `src/pipeline/process-event.ts:36-49`
- Test: `tests/pipeline/process-event.test.ts`

**Interfaces:**
- Consumes：Task 2 的 `CanonicalEvent.severity`。
- Produces：`processEvent` 簽名不變。

- [ ] **Step 1: 寫失敗測試**
  - `event.severity 取代規則表`：規則表把該 errorType 判為 P1，event 帶 `severity:'P0'`。預期新建 issue 的 severity 為 `'P0'`。
  - `event.severity 較低時，新 issue 採用它`：規則判 P1，event 帶 P2，且 issue 為新建。預期 severity 為 `'P2'`。
    - 前提：新 issue 的初始 severity 由 store 決定。先在 `InMemoryStore` 確認建立時的預設值；若預設值高於 P2，此 case 改為驗證 ratchet 維持預設值，並在測試註解寫明原因。
  - `ratchet 仍生效`：既有 issue 為 P1，event 帶 P2。預期 issue 仍為 `'P1'`，且不呼叫 `updateIssueTriage`。
  - `無 event.severity 時走規則表`：沿用既有 case，不得退化。

- [ ] **Step 2: 執行，確認失敗**
  Run：`pnpm vitest run tests/pipeline/process-event.test.ts`

- [ ] **Step 3: 實作**
  - `evaluated` 的來源改為：`event.severity` 有值時用它，`tags` 沿用 issue 現有的 tags；否則呼叫 `evaluateSeverity`。
  - 有 `event.severity` 時不必載入規則（`loadRules` 可跳過）。

- [ ] **Step 4: 執行 `pnpm vitest run tests/pipeline`**
  Expected：PASS。

- [ ] **Step 5: Commit**
  ```bash
  git add src/pipeline/process-event.ts tests/pipeline/process-event.test.ts
  git commit -m "feat(pipeline): event 帶 severity 時取代規則表判級（ratchet 不變）"
  ```

---

### Task 4: 通知——門檻 P2、診斷欄位、顏色取 event severity

**Files:**
- Modify: `src/notify/decision.ts:4`
- Modify: `src/notify/message.ts`
- Modify: `src/pipeline/process-and-notify.ts:40-78`
- Test: `tests/notify/decision.test.ts`
- Test: `tests/notify/message.test.ts`
- Test: `tests/pipeline/process-and-notify.test.ts`

**Interfaces:**
- Consumes：Task 2 的 `event.severity`、`metadata.diagnosis`、`metadata.diagnosisError`。
- Produces：`NotifyDetails` 新增以下欄位：
  ```ts
  category?: DiagnosisCategory
  diagnosisReason?: string
  suggestion?: string
  diagnosisError?: string
  ```

- [ ] **Step 1: 寫失敗測試**
  - decision：`P2 達門檻會發送`，預期 `shouldNotify({severity:'P2', duplicate:false, lastSent:null, now})` 回傳 `{notify:true, reason:'first'}`。原有的 `below_threshold` case 要改寫，或改為顯式傳入 `minSeverity:'P1'`。
  - message：
    - `extractNotifyDetails 取出 diagnosis`：metadata 為 `{diagnosis:{category:'env', severity:'P2', reason:'R', suggestion:'S'}}`，預期回傳 `{category:'env', diagnosisReason:'R', suggestion:'S'}`。
    - `diagnosis 結構不合法時不取`：例如 `category` 不是 `env`/`app`。
    - `extractNotifyDetails 取出 diagnosisError`。
  - message：`有分類時標題為中文判定`：
    - env → `title === '[P2] svc — 環境問題'`
    - app → `'[P1] svc — app 問題'`
    - 無分類 → 維持 `'[P1] svc — test_failure'`
  - message：`欄位順序與標籤`：
    - fields 依序出現 `判定原因`、`修正建議`、`AI 判讀失敗`（有值才出現）。
    - 位置在 `失敗摘要` 之後、`CI Run` 之前。
  - process-and-notify：
    - `顏色與紀錄取 event severity`：issue 已是 P1（ratchet），event 帶 P2。預期 sender 收到的 embed color 為 `0x95a5a6`，且 `recordNotification` 的 severity 為 `'P2'`。
    - `無 event severity 時取 issue severity`：既有行為維持不變。

- [ ] **Step 2: 執行，確認失敗**
  Run：`pnpm vitest run tests/notify tests/pipeline/process-and-notify.test.ts`

- [ ] **Step 3: 實作**
  - `NOTIFY_MIN_SEVERITY = 'P2'`。
  - `buildDiscordMessage` 的 params 不新增 key，標題依 `details.category` 決定。
  - `DETAIL_LABELS` 加入三組：`['diagnosisReason','判定原因']`、`['suggestion','修正建議']`、`['diagnosisError','AI 判讀失敗']`。
  - `extractNotifyDetails` 從 `metadata.diagnosis` 物件白名單萃取，套用 `pickString` 的截斷。
  - `notifyStage` 定義 `const severity = event.severity ?? result.issue.severity`，並把它用在三處：`shouldNotify`、`buildDiscordMessage`、`recordNotification`。

- [ ] **Step 4: 執行 `pnpm test && pnpm typecheck`**
  Expected：全部 PASS。

- [ ] **Step 5: Commit**
  ```bash
  git add src/notify/decision.ts src/notify/message.ts src/pipeline/process-and-notify.ts tests/notify/decision.test.ts tests/notify/message.test.ts tests/pipeline/process-and-notify.test.ts
  git commit -m "feat(notify): P2 也發 Discord；附 AI 判定原因與修正建議，顏色取當次 severity"
  ```

---

### Task 5: handleHeartbeat 串接、整合測試與 API 文件

**Files:**
- Modify: `src/heartbeat/handle-heartbeat.ts:69-94`
- Modify: `docs/api.md`（heartbeat 章節）
- Test: `tests/heartbeat/handle-heartbeat.test.ts`
- Test: `tests/integration/heartbeat-route.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `report.diagnosis` / `report.diagnosisError`，Task 2 的 `TEST_FAILURE_ENV`。
- Produces：response body 新增 `errorType`（fail 且建立 issue 時，值為 `'test_failure'` 或 `'test_failure_env'`）。

- [ ] **Step 1: 寫失敗測試**（`handle-heartbeat.test.ts`）
  - `env 診斷建立 test_failure_env issue 並採用其 severity`：
    - 預期 open issues 只有一筆，`errorType === 'test_failure_env'`、`severity === 'P2'`。
    - 預期 body 的 `errorType === 'test_failure_env'`、`notified === true`。
  - `app 診斷與 env 診斷分屬兩筆 issue`：先後送出 env、app 兩次 fail，預期 open issues 有兩筆，errorType 各不相同。
  - `pass 帶 diagnosis 時忽略且 resolve 兩筆 issue`：先建立 env 與 app 兩筆 open issue，再送 pass（夾帶 diagnosis）。預期 open issues 為 0，且沒有新增任何 issue。
  - `不合法 diagnosis → 200 + warnings，退回 test_failure P1`：預期 `status === 200`、body `warnings` 非空、issue 的 `severity === 'P1'`。

- [ ] **Step 2: 執行，確認失敗**
  Run：`pnpm vitest run tests/heartbeat/handle-heartbeat.test.ts`

- [ ] **Step 3: 實作**
  - fail 分支把 `diagnosis`、`diagnosisError` 傳給 `normalizeHeartbeatFailure`。
  - pass 分支額外 resolve `heartbeatFingerprint(serviceId, TEST_FAILURE_ENV, name)`。

- [ ] **Step 4: 補整合測試**
  在 `tests/integration/heartbeat-route.test.ts` 加一個 case：`env 診斷寫入 events.metadata.diagnosis 並建立 test_failure_env issue`，透過真實 store 驗證 DB 內容。

- [ ] **Step 5: 更新 `docs/api.md`**
  - 在 heartbeat payload 表格加入 `diagnosis`（含子欄位、enum、長度上限）與 `diagnosisError`。
  - 註明以下三點：
    - 不合法時只丟棄並回 warning，不會 422。
    - pass 時忽略這兩個欄位。
    - env 類失敗會建立獨立 issue。

- [ ] **Step 6: 全量驗證**
  - Run：`pnpm typecheck && pnpm test`
  - 本地 stack 須已啟動（OrbStack + `supabase start` + `supabase db reset`），再 Run：`pnpm test:integration`
  - Expected：全部 PASS。integration 只能指向本地 stack。

- [ ] **Step 7: Commit**
  ```bash
  git add src/heartbeat/handle-heartbeat.ts docs/api.md tests/heartbeat/handle-heartbeat.test.ts tests/integration/heartbeat-route.test.ts
  git commit -m "feat(heartbeat): 串接 AI 診斷；pass 同時 resolve test_failure_env"
  ```

---

### Task 6: CI 共用腳本（判讀＋心跳夾帶）

**Files:**
- Create: `scripts/diagnose-e2e-failure.sh`（chmod +x）
- Modify: `scripts/heartbeat-to-beacon.sh`
- Test（新增）：`tests/scripts/diagnose-e2e-failure.test.ts`
- Test（新增）：`tests/scripts/heartbeat-to-beacon.test.ts`

**Interfaces:**

`diagnose-e2e-failure.sh`
- 用法：`diagnose-e2e-failure.sh <platform> <known-issues-file> <output-file> <log-file>...`
- 認證環境變數（擇一模式）：
  - **WIF 模式**（CI 用）：
    - `ANTHROPIC_FEDERATION_RULE_ID`、`ANTHROPIC_ORGANIZATION_ID`、`ANTHROPIC_SERVICE_ACCOUNT_ID`
    - 選填 `ANTHROPIC_WORKSPACE_ID`：有值才放進 body
    - `ACTIONS_ID_TOKEN_REQUEST_URL`、`ACTIONS_ID_TOKEN_REQUEST_TOKEN`：由 runner 提供
  - **API key 模式**（僅限本機手動測試）：設定 `ANTHROPIC_API_KEY` 時跳過 WIF，改用 `x-api-key`
  - 兩種都不齊全時，輸出 `{"error":"no credentials"}`，且不發出任何請求。
- 其他環境變數：
  - `ANTHROPIC_BASE_URL`（預設 `https://api.anthropic.com`）
  - `DIAGNOSE_MODEL`（預設 `claude-sonnet-5-5`）
  - `DIAGNOSE_MAX_BYTES`（預設 `150000`）
  - `DIAGNOSE_REDACT_VARS`：以空白分隔的「環境變數名稱」清單，腳本取這些變數的值來遮蔽
- 輸出檔有兩種形態：
  - 成功：`{"category","severity","reason","suggestion","model"}`
  - 失敗：`{"error":"<≤200 字>"}`
- stdout 印出 `usage` 的 token 數，供 CI log 查成本。
- 一律 `exit 0`。

`heartbeat-to-beacon.sh`
- 新增可選的第 5 參數 `[diagnosisFile]`：
  - 檔案含 `.error` → payload 加 `diagnosisError`。
  - 檔案含 `.category` → payload 加 `diagnosis`（整個物件）。
  - 檔案不存在或無法解析 → 忽略。
- 前 4 個參數的行為不變。

- [ ] **Step 1: 寫失敗測試**（vitest + `node:http` 假 server + `child_process.spawnSync('bash', ...)`）

  diagnose 腳本：
  - `成功時寫出 diagnosis 並帶 model`：假 server 回傳 `{stop_reason:'end_turn', content:[{type:'text', text:'{"category":"env","severity":"P2","reason":"r","suggestion":"s"}'}], usage:{input_tokens:1, output_tokens:1}}`。預期輸出檔 JSON 等於上述四欄再加上 `model:'claude-sonnet-5-5'`，exit code 為 0。
  - `WIF 模式依序取 JWT、換 token、帶 Bearer 呼叫`：
    - 假 server 同時扮演三個端點：
      - OIDC：`ACTIONS_ID_TOKEN_REQUEST_URL` 指向 `http://127.0.0.1:<port>/oidc?x=1`，回傳 `{value:'JWT_FAKE'}`
      - `/v1/oauth/token`：回傳 `{access_token:'sk-ant-oat01-FAKE', token_type:'Bearer', expires_in:600}`
      - `/v1/messages`
    - 預期 OIDC 請求：
      - query 含 `audience=https://api.anthropic.com`（URL-encoded 亦可）
      - `authorization` 為 `Bearer <ACTIONS_ID_TOKEN_REQUEST_TOKEN>`
    - 預期 oauth body：
      - `grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer'`
      - `assertion === 'JWT_FAKE'`
      - 含 `federation_rule_id`、`organization_id`、`service_account_id`
      - 未設 `ANTHROPIC_WORKSPACE_ID` 時不含 `workspace_id`
    - 預期 messages 請求帶 `authorization: Bearer sk-ant-oat01-FAKE`，且沒有 `x-api-key`。
    - 預期腳本的 stdout 與輸出檔都不含 `JWT_FAKE` 和 `sk-ant-oat01-FAKE`。
  - `換 token 回 401 時輸出 error 且不呼叫 messages`：
    - 預期輸出檔 `.error` 含 `401`。
    - 預期假 server 沒收到 `/v1/messages`。
  - `沒有任何憑證時輸出 no credentials`。
  - `request 形狀正確`（API key 模式）：預期假 server 收到：
    - path 為 `/v1/messages`
    - headers 含 `x-api-key`、`anthropic-version`
    - body 的 `model === 'claude-sonnet-5-5'`
    - `body.output_config.format.type === 'json_schema'`
    - `body.output_config.format.schema.required` 為 `['category','severity','reason','suggestion']`
    - body 不含 `temperature`
    - system prompt 含 known-issues 檔的內容
  - `含特殊字元的秘密被逐字遮蔽`：
    - 設 `E2E_PW='a$b.c/d\\e'`、`DIAGNOSE_REDACT_VARS='E2E_PW'`，log 內含該字串。
    - 預期 request body 不含原字串，且含 `***`。
  - `非 UTF-8 log 仍送出合法 request`：log 含 `\xff\xfe` 位元組。預期假 server 收到可被 `JSON.parse` 的 body，輸出檔為成功形態。
  - `超過 DIAGNOSE_MAX_BYTES 只取尾段`：設 `DIAGNOSE_MAX_BYTES=1000`，log 長 5000 且結尾為 `TAIL_MARKER`。預期送出的 log 內容 ≤ 1000 bytes 且含 `TAIL_MARKER`。
  - `stop_reason 非 end_turn 時輸出 error`：分別以 `max_tokens`、`refusal` 回應。預期輸出檔有 `.error`、沒有 `.category`。
  - `HTTP 500 時輸出 error 且 exit 0`。
  - `所有 log 檔都不存在時輸出 error`。

  heartbeat 腳本（假 server 收 POST）：
  - `第 5 參數為 diagnosis 檔時 payload 含 diagnosis`。
  - `第 5 參數為 error 檔時 payload 含 diagnosisError`。
  - `第 5 參數缺省或檔案不存在時 payload 與舊版相同`。
  - `簽章仍可被 verifyIngestSignature 驗過`：從 `@/ingest/hmac` 匯入 `verifyIngestSignature`，對收到的 body、headers 做驗證。

- [ ] **Step 2: 執行，確認失敗**
  Run：`pnpm vitest run tests/scripts`

- [ ] **Step 3: 實作 `diagnose-e2e-failure.sh`**
  - system prompt 寫在腳本的 heredoc 中，內容須包含：
    - 任務說明
    - spec §5.3 的嚴重度定義（P0／P1／P2 三條原文照抄）
    - 分類原則：任一段落屬於 app 問題，整體即判 `app`；不確定時判 `app`
    - 長度要求：`reason` ≤ 150 字、`suggestion` ≤ 300 字且須具體可執行
    - 繁體中文
    - 最後附上 known-issues 檔的內容
  - log 依序串接各檔的尾段，每段前加 `=== <檔名> ===` 標頭。總量不超過 `DIAGNOSE_MAX_BYTES`，按檔案數平均分配。
  - 非 UTF-8 處理：`iconv -c -f utf-8 -t utf-8`，或 `perl -CSD` 清洗。
  - 遮蔽：用 `perl` 搭配 `\Q...\E` 做逐字替換，秘密值經由環境變數傳入 perl，不嵌進程式碼字串。
  - 用 `jq -n --rawfile` 組 body。
  - 回應檢查：`stop_reason == "end_turn"`，取第一個 text block 做 `jq` 解析，並驗證四個欄位都存在。

- [ ] **Step 4: 實作 `heartbeat-to-beacon.sh` 的第 5 參數**（`jq --slurpfile`）。

- [ ] **Step 5: 執行 `pnpm vitest run tests/scripts && pnpm test`**
  Expected：PASS。

- [ ] **Step 6: 以真實 API 試跑一次**（走 API key 模式，需要使用者在本機提供 `ANTHROPIC_API_KEY`；沒有就略過，並在回報中標注「未實測」。WIF 路徑留到 Task 9 在 CI 上實測）
  - 用 `gh run download` 取 Android 2026-10-21 那次失敗 run 的 `e2e-prod-reports` artifact（保留 7 天）。
  - 執行：`./scripts/diagnose-e2e-failure.sh android <暫存的 known-issues 檔> out.json e2e.log logcat.txt`
  - Expected：`out.json` 的 `category` 為 `env`，`reason` 或 `suggestion` 提到沉浸模式確認提示。記錄 `usage` 的 token 數，回填到 spec §5.4 的成本估算。

- [ ] **Step 7: Commit**
  ```bash
  git add scripts/diagnose-e2e-failure.sh scripts/heartbeat-to-beacon.sh tests/scripts/diagnose-e2e-failure.test.ts tests/scripts/heartbeat-to-beacon.test.ts
  git commit -m "feat(scripts): CI 失敗 AI 判讀腳本；心跳腳本可夾帶 diagnosis"
  ```

---

### Task 7: Android CI 接入（repo：`../trustnel-viewer-android`）

**Files:**
- Copy：`scripts/diagnose-e2e-failure.sh`、`scripts/heartbeat-to-beacon.sh`，來源為 th-beacon，必須位元組一致。
- Create：`.github/e2e-known-env-issues.md`
- Modify：`.github/workflows/e2e-prod.yml`（在 heartbeat step 之前插入判讀 step，並修改 heartbeat step）
- Modify：`CLAUDE.md` 的 secrets／variables 清單：
  - 補上原本漏列的 `YOUTUBE_API_KEY`
  - 新增 repo variables：`ANTHROPIC_FEDERATION_RULE_ID`、`ANTHROPIC_ORGANIZATION_ID`、`ANTHROPIC_SERVICE_ACCOUNT_ID`
  - 註明「AI 判讀走 WIF，無 API key」

**Interfaces:**
- Consumes：Task 6 的腳本介面。

- [ ] **Step 1: 複製腳本並驗證**
  Run：`cmp ../th-beacon/scripts/diagnose-e2e-failure.sh scripts/diagnose-e2e-failure.sh && cmp ../th-beacon/scripts/heartbeat-to-beacon.sh scripts/heartbeat-to-beacon.sh`
  Expected：無輸出（兩組檔案完全一致）。

- [ ] **Step 2: 撰寫 `.github/e2e-known-env-issues.md`**
  內容取自 `e2e-prod.yml` 與 `scripts/ci-e2e-run.sh` 註解中的歷史紀錄，逐條列出「症狀（log 特徵）→ 根因 → 既有對策／建議」：
  - 沉浸模式確認提示
  - ANR 對話框（`RootViewWithoutFocusException`）
  - ENOSPC → `No connected devices!`
  - GMS 冷開機 SQLite 鎖／system_server contention
  - Gradle 與 emulator 搶資源
  - 鎖區影片誤報
  - job timeout
  - 必要環境變數／secret 為空 → `e2e.sh` 開頭就退出 → env、P1

- [ ] **Step 3: 新增 step `Diagnose failure with Claude`**
  - 位置：`Report heartbeat` 之前。
  - 設定：
    - `if: failure() || cancelled()`
    - `continue-on-error: true`
    - `timeout-minutes: 3`
  - job 層加上 `permissions: { id-token: write, contents: read }`。
  - env：
    - `ANTHROPIC_FEDERATION_RULE_ID: ${{ vars.ANTHROPIC_FEDERATION_RULE_ID }}`
    - `ANTHROPIC_ORGANIZATION_ID: ${{ vars.ANTHROPIC_ORGANIZATION_ID }}`
    - `ANTHROPIC_SERVICE_ACCOUNT_ID: ${{ vars.ANTHROPIC_SERVICE_ACCOUNT_ID }}`
    - `DIAGNOSE_REDACT_VARS: "TRUSTNEL_E2E_EMAIL TRUSTNEL_E2E_PASSWORD TRUSTNEL_E2E_LOCK TRUSTNEL_SUPABASE_PUBLISHABLE_KEY TRUSTNEL_YOUTUBE_API_KEY BEACON_SECRET"`
    - 上列各遮蔽變數的實際值，從對應的 secrets 帶入
  - run：
    - `ANTHROPIC_FEDERATION_RULE_ID` 未設時印 skip 並 `exit 0`。
    - 否則執行：`./scripts/diagnose-e2e-failure.sh android .github/e2e-known-env-issues.md "${RUNNER_TEMP}/diagnosis.json" "${RUNNER_TEMP}/e2e.log" "${RUNNER_TEMP}/logcat.txt"`

- [ ] **Step 4: 修改 heartbeat step**
  - 呼叫時加上第 5 參數 `"${RUNNER_TEMP}/diagnosis.json"`。判讀被跳過時檔案不存在，腳本會忽略。
  - summary 回退改寫（spec §6.3）：grep 抓不到段落結論、但 `e2e.log` 有內容時，SUMMARY 改為 `job=${JOB_STATUS}：<最後一行非空內容>`。
    - 先用 `sed` 去掉 ANSI 色碼
    - 截到 200 字元
    - 檔案不存在或內容為空時，維持原本的回退文字
  - 本地驗證：建一個只有 `找不到 /x/.env（…）` 一行的假 `e2e.log`，執行該段 shell。
    - Expected：SUMMARY 為 `job=failure：找不到 /x/.env（…）`。

- [ ] **Step 5: 靜態驗證**
  Run：`actionlint .github/workflows/e2e-prod.yml`（若未安裝，改用 `python3 -c "import yaml,sys;yaml.safe_load(open(sys.argv[1]))" .github/workflows/e2e-prod.yml`）
  Expected：無錯誤。

- [ ] **Step 6: Commit（在 Android repo）**
  ```bash
  git add scripts/diagnose-e2e-failure.sh scripts/heartbeat-to-beacon.sh .github/e2e-known-env-issues.md .github/workflows/e2e-prod.yml CLAUDE.md
  git commit -m "ci(e2e): 失敗時先以 Claude 判讀 log，結果隨心跳回報 th-beacon"
  ```

---

### Task 8: iOS CI 接入（repo：`../trustnel-viewer-ios`）

**Files:** 與 Task 7 相同，對應 iOS 的路徑。

- [ ] **Step 1: 前置確認（自架 runner）**
  請使用者在 runner 機器上執行：
  - `jq --version`
  - `perl -v | head -2`
  - `curl -sS -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/messages`

  Expected：jq 與 perl 都存在；curl 回 `401` 或 `405` 這類 HTTP 碼，代表連得上 API，而不是連線錯誤。（GitHub OIDC 端點能否連通，留到 Task 9 實跑時驗證。）
  若任一項不符，停下回報，不繼續後續步驟。

- [ ] **Step 2: 複製腳本並以 `cmp` 驗證**（同 Task 7 Step 1）

- [ ] **Step 3: 撰寫 `.github/e2e-known-env-issues.md`**
  iOS 至少列出以下項目（Android 的清單也要加第一條）：
  - 必要環境變數／secret 為空 → `e2e.sh` 開頭就退出（2026-10-23 實例：`TRUSTNEL_SUPABASE_PUBLISHABLE_KEY` 為空 → `找不到 …/.env`）→ env、P1
  - simulator 開機失敗（`simctl boot` 被吞錯）
  - 自架 runner 殘留狀態（舊 sim、DerivedData）
  - iOS runtime 低於 26
  - 線上 API 無回應導致前置健檢 `exit 1`
  - 鎖區影片
  - job timeout

- [ ] **Step 4: 新增判讀 step、修改 heartbeat step**
  - 設定同 Task 7 Step 3–4，但：
    - platform 參數為 `ios`
    - log 只傳 `${RUNNER_TEMP}/e2e.log`
  - `DIAGNOSE_REDACT_VARS` 依 iOS workflow 實際的 env 名稱調整（例如 `TRUSTNEL_YOUTUBE_API_KEY`）。

- [ ] **Step 5: 靜態驗證**（同 Task 7 Step 5）

- [ ] **Step 6: Commit（在 iOS repo）**
  ```bash
  git add scripts/diagnose-e2e-failure.sh scripts/heartbeat-to-beacon.sh .github/e2e-known-env-issues.md .github/workflows/e2e-prod.yml
  git commit -m "ci(e2e): 失敗時先以 Claude 判讀 log，結果隨心跳回報 th-beacon"
  ```

---

### Task 9: 上線與實測（須使用者介入）

- [ ] **Step 1: 確認 th-beacon 已上線**
  - 請使用者 push th-beacon，等 Vercel 部署完成。
  - 部署前 Android、iOS repo **不可** push：舊版 server 會忽略新欄位，雖然不會壞，但驗不到任何東西。

- [ ] **Step 2: 設定 WIF**（依 spec §5.5）
  - 請使用者在 Console 操作：Workload identity → Connect workload → GitHub Actions。
    - issuer 一個、service account 一個（`e2e-triage`）。
    - rule 兩條，Android、iOS 各一條，`subject_prefix` 分別鎖定該 repo 的 `ref:refs/heads/main`。
    - `oauth_scope: workspace:developer`（Console 只提供 workspace:developer／org:admin，inference 僅 Admin API 可設；rule 已鎖 repo＋main、token 600 秒），`token_lifetime_seconds: 600`。
  - 把 rule ID、org ID、service account ID 設成各 repo 的 Actions variables。注意兩個 repo 的 `ANTHROPIC_FEDERATION_RULE_ID` 不同。
  - 建議在 Console 對該 workspace 設定用量上限。

- [ ] **Step 3: push 兩個 CI repo 並觸發失敗**
  - 請使用者 push 兩個 CI repo。
  - 用 `workflow_dispatch` 各觸發一次。若要刻意製造失敗，可暫時把 `TRUSTNEL_E2E_PASSWORD` 改錯；之後務必改回。

- [ ] **Step 4: 驗證結果**
  - Discord 訊息：
    - 標題含「環境問題」或「app 問題」
    - 有「判定原因」與「修正建議」兩個欄位
    - 顏色與 severity 一致
  - dashboard issue 詳情頁的 metadata 含 `diagnosis`。
  - CI log 中的 request 沒有出現秘密值：搜尋密碼的前幾個字元，應該找不到。也找不到 `sk-ant-oat01` 與 `eyJ`（JWT 開頭）。
  - Console 的 authentication history 有兩個 repo 各自成功換 token 的紀錄。若失敗，依 history 顯示的 deny reason 修正 rule。
  - 現有 step（checkout、cache、upload-artifact）在加上 `permissions` 之後仍然成功。
  - 讓兩個 repo 各跑一次 pass，確認兩筆 issue 都被 resolve。

- [ ] **Step 5: 回填 spec 並 commit**
  - 把實測的 token 數與成本寫回 spec §5.4。
  - 把「job 逾時後判讀 step 是否還會執行」的實測結果寫回 spec §5.1。
  - 若有實測到逾時情境，依結果更新；若沒有，註明「尚未遇到」。
  ```bash
  git add docs/superpowers/specs/2026-10-23-e2e-failure-ai-triage-design.md
  git commit -m "docs(spec): 回填 AI 判讀實測成本與逾時行為"
  ```
