# E2E 失敗 AI 判讀（通報前先讓 Claude 看 log）

日期：2026-10-23
狀態：設計定稿，待寫 plan

## 1. 為什麼要做

Trustnel 的 Android／iOS 每日 e2e（`android-e2e-prod`、`ios-e2e-prod`）經常失敗，Android 尤其頻繁，但多數失敗並非 app 有問題，而是測試環境不穩造成。例如 2026-10-16 至 10-21 連續四輪紅燈，元兇都是系統的沉浸模式確認提示搶走 focus。

現況是：每次失敗都以 P1 橘色發到 Discord，值班者必須事後請 Claude 讀 log，才知道「原來是環境問題」。告警的訊號價值因此被稀釋。

目標是把「讀 log → 判斷」這一步搬到通報**之前**：CI 失敗時先把 log 餵給 Claude API，由同一次呼叫產出以下四項，再交由 th-beacon 依結果發 Discord：

1. 分類：環境問題或 app 問題
2. 嚴重度：P0／P1／P2
3. 簡短原因
4. 修正建議

## 2. 目標／非目標／反目標

**目標**

- 每次 e2e 失敗只呼叫一次 Claude API，以固定 JSON schema 產出 `category`、`severity`、`reason`、`suggestion`。
- 環境造成的失敗與 app 造成的失敗拆成**兩筆獨立 issue**，各自計數。這樣環境問題重複發生時，不會蓋過真正的 app 問題。
- Discord 顏色沿用現有對照：P0 紅、P1 橘、P2 灰。標題標明是「環境問題」還是「app 問題」，並附上原因與修正建議。
- P2 也要發 Discord（全域門檻由 P1 降到 P2）。
- 提早退出時，summary 改用 log 最後一行，不再只有 `job=failure`（見 §6.3）。

**非目標**

- 不自動修 CI、不開 PR。修正建議只是訊息中的文字。
- 判讀過程不使用 `gh` CLI，也不跑 agent loop。只做一次 Messages API 呼叫，log 由 CI 直接餵入。
- th-beacon 伺服器端不呼叫 Claude，不持有 Anthropic key 或 GitHub token。
- 不做 dashboard 新 UI。診斷內容放在 event metadata，issue 詳情頁本來就會整包顯示。
- 不處理 reopen 復發語意（另案）。

**反目標（技術上能動，但算失敗）**

- **AI 掛掉導致告警消失。** Claude 呼叫失敗、逾時、回傳格式不符時，必須退回現行行為（`test_failure`、規則表判 P1）照常發送，並在訊息中註明「AI 判讀失敗」。
- **把秘密送給第三方。** `e2e.log` 是 `tee` 出來的檔案，GitHub 的 secret 遮罩不會作用在檔案上。送出前必須遮蔽已知秘密。
- **判讀 step 失敗拖垮心跳。** 心跳一旦沒送出，隔天就會觸發假的 `heartbeat_missed`。
- 舊版 CI（沒帶診斷欄位）送來的回報被拒收，或行為改變。

## 3. 已拍板的決策（使用者決定）

| 決策 | 內容 |
|---|---|
| 判讀在哪跑 | 在**各專案 CI** 內，失敗後、回報 th-beacon 前 |
| 呼叫方式 | 直接打 Claude Messages API，把 log 餵進去；不用 `gh` |
| 呼叫次數 | 每次失敗**一次**呼叫，同時產出分類、嚴重度、原因、建議 |
| 輸出格式 | 以 JSON schema 限制（structured outputs） |
| 嚴重度來源 | 有診斷時由 Claude 決定，th-beacon 直接採用，不走 triage 規則表 |
| 顏色 | 依嚴重度：P0 紅、P1 橘、P2 灰；環境問題**不**另用黃色 |
| 環境 vs app | 拆成兩筆 issue |
| P2 通知 | 全域開放：`NOTIFY_MIN_SEVERITY` 改為 P2。查線上 DB（2026-10-23）時從未出現 P2 issue，7 筆 issue 全是 CI 心跳類 P1，目前全域開放沒有洗版風險。日後有服務接上 `/api/ingest` 且 P2 太吵時，再調整 |
| 模型 | `claude-sonnet-5-5` |
| 認證 | **Workload Identity Federation（WIF）**，不用 API key：GitHub Actions 發 OIDC JWT → 換成短效 Claude token。CI 不存任何 Anthropic 秘密（見 §5.5） |
| iOS summary | 一併修正 |

## 4. 架構

```
CI（Android / iOS）
  e2e 失敗
   └─ diagnose-e2e-failure.sh  ← 新增（共用腳本，源頭在 th-beacon/scripts/）
        讀 e2e.log（＋ Android logcat.txt）尾段 → 遮蔽秘密
        → POST api.anthropic.com/v1/messages（structured outputs）
        → 產出 diagnosis.json（失敗時產出 {"error": "..."}）
   └─ heartbeat-to-beacon.sh（擴充：可選第 5 參數＝diagnosis.json 路徑）
        → POST /api/heartbeat  { name, status, runUrl, summary, diagnosis? | diagnosisError? }

th-beacon
  parseHeartbeatPayload：驗證 diagnosis（不合法 → 丟棄並回 warning，不拒收）
  normalizeHeartbeatFailure：
    category=env → errorType 'test_failure_env'（自己的 fingerprint）
    category=app 或無診斷 → errorType 'test_failure'（沿用）
    diagnosis 寫進 event.metadata
  processEvent：event 帶 severity 時以它取代規則表判級（ratchet 仍適用）
  通知：門檻 P2；Discord 新增「判定」「原因」「修正建議」欄位
  pass：同時 resolve test_failure 與 test_failure_env
```

## 5. Claude 呼叫規格（CI 端）

### 5.1 共用腳本 `scripts/diagnose-e2e-failure.sh`

- 源頭放在 th-beacon `scripts/`，兩個 CI repo 各複製一份。做法與現行 `heartbeat-to-beacon.sh` 相同，以 `cmp` 確保位元組一致。
- 技術：bash＋`curl`＋`jq`。兩邊 runner 都已有這些工具，heartbeat 腳本也在用。不引入 Node 或 Python。
- 輸入：
  - WIF 設定（非秘密，放 repo variables）：`ANTHROPIC_FEDERATION_RULE_ID`、`ANTHROPIC_ORGANIZATION_ID`、`ANTHROPIC_SERVICE_ACCOUNT_ID`，選填 `ANTHROPIC_WORKSPACE_ID`
  - GitHub runner 自動提供的 `ACTIONS_ID_TOKEN_REQUEST_URL`／`ACTIONS_ID_TOKEN_REQUEST_TOKEN`（job 需 `id-token: write`）
  - 平台名（`android`／`ios`）
  - log 檔路徑：一或多個
  - 「已知環境問題」說明檔路徑（見 §5.3）
  - 輸出檔路徑
- 呼叫參數：
  - `model: "claude-sonnet-5-5"`
  - `max_tokens` 約 2000
  - `output_config: {format: {type: "json_schema", schema: <§5.2>}}`
  - 不送 `temperature`（2026-10-21 起送了會 400）
  - `curl --max-time 100`，失敗不重試（CI 已經夠久了）
- 結果處理：
  - `stop_reason` 不是 `end_turn`（例如 `refusal`、`max_tokens`）、HTTP 錯誤、或 JSON 無法解析 → 輸出 `{"error": "<簡短原因>"}`
  - 腳本本身一律 `exit 0`，絕不讓判讀失敗影響後續心跳 step
- 在 workflow 中的位置：
  - 放在「Report heartbeat」之前
  - 條件 `if: failure() || cancelled()`：只有失敗或逾時（GitHub 把 job timeout 判為 cancelled，Android 2026-09-01 發生過）才呼叫，成功不花錢
  - 加 `continue-on-error: true`
  - step 的 `timeout-minutes` 設 3
  - job 逾時被取消後，後續 step 是否還能執行**未確認**。實作時要實測：若不會執行，就接受「逾時不判讀，退回現行行為」，不另外設計補救機制。
- 前置確認：iOS 自架 runner 是否有 `jq`，以及能否對外連到 `api.anthropic.com`。plan 的第一個 CI 任務先驗證這兩點。
- 認證改用 WIF，不建立 API key，細節見 §5.5。

### 5.5 認證：Workload Identity Federation

依官方文件（platform.claude.com/docs/en/manage-claude/wif-providers/github-actions，2026-10-23 查閱）：

- **流程**（腳本內完成，每次 run 一次）：
  1. 取 GitHub OIDC JWT：`curl -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://api.anthropic.com" | jq -r .value`
  2. 換 token：`POST /v1/oauth/token`，JSON body：
     - `grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer"`
     - `assertion: <JWT>`
     - `federation_rule_id`、`organization_id`、`service_account_id`
     - `workspace_id`（rule 只綁一個 workspace 時可省略）
     - 回傳 `access_token`（`sk-ant-oat01-…`）
  3. 呼叫 Messages API：header 用 `authorization: Bearer <access_token>`，不需額外 beta header。
- **注意事項**：
  - GitHub JWT 約 5 分鐘過期，且帶 `jti` 只能換一次。腳本必須在呼叫前現取，不可快取、不可重送同一個 JWT（腳本本來就不重試）。
  - 換 token 失敗一律回 401 `Authentication failed`，不說原因。腳本輸出 `{"error":"wif exchange failed: 401"}`；真正原因要到 Console 的 authentication history 查。
  - 自架 runner（iOS）一樣能取得 GitHub OIDC token，但要能連到 `token.actions.githubusercontent.com`（由 runner 環境變數提供的 URL）與 `api.anthropic.com`。
- **Console 設定**（使用者操作；Workload identity → Connect workload → GitHub Actions）：
  - Issuer：`https://token.actions.githubusercontent.com`，discovery 模式。
  - Service account：一個，例如 `e2e-triage`。
  - Federation rule：每個 repo 各一條。
    - `subject_prefix: repo:trustnel/trustnel-viewer-android:ref:refs/heads/main`（iOS 同理）
    - `audience: https://api.anthropic.com`
    - `claims: {repository_owner: trustnel}`
    - `oauth_scope: workspace:developer`：Console 只提供 `workspace:developer`／`org:admin`（`workspace:inference` 僅 Admin API 可設）；權限以 rule 鎖定 repo＋main、token 600 秒來收斂
    - `token_lifetime_seconds: 600`
  - schedule 與 `workflow_dispatch`（在 main 上執行）的 `sub` 都是 `repo:<owner>/<repo>:ref:refs/heads/main`。從其他分支手動觸發會被拒絕，這是預期行為。
- **workflow 變更**：
  - e2e job 加上 `permissions: { id-token: write, contents: read }`。
  - 目前兩個 workflow 都沒有設 `permissions`，加上後其他權限會收斂到只剩這兩項。現有 step（checkout、cache、upload-artifact）不需要其他權限，但要實跑確認。
- **本地手動測試的退路**：腳本另外接受 `ANTHROPIC_API_KEY`（有設定時跳過 WIF，改用 `x-api-key`），只給開發者本機試跑用，workflow 不設定。

### 5.2 輸出 schema（固定）

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["category", "severity", "reason", "suggestion"],
  "properties": {
    "category":   { "type": "string", "enum": ["env", "app"] },
    "severity":   { "type": "string", "enum": ["P0", "P1", "P2"] },
    "reason":     { "type": "string" },
    "suggestion": { "type": "string" }
  }
}
```

- structured outputs 不支援 `maxLength`，因此長度限制寫在 prompt 裡：
  - `reason` ≤ 150 字
  - `suggestion` ≤ 300 字
  - th-beacon 端另做截斷保險
- 輸出語言：繁體中文。

### 5.3 Prompt 內容（要點；措辭留給實作者）

- 角色與任務：判讀行動 app 每日 e2e 失敗的 log，判斷失敗來自測試環境或 app 本身。
- **嚴重度定義**（寫進 system prompt，兩平台共用）：
  - P0：app 核心流程確定壞掉（登入、配對、播放主流程），使用者會直接受影響。
  - P1：app 問題但影響有限；或環境問題使整個 e2e 無法跑完、完全失去監控價值（例如 emulator 起不來、磁碟爆滿）。
  - P2：已知或可辨識的環境干擾，只影響部分段落（例如系統彈窗搶 focus、抽到鎖區影片）。
- **分類原則**：多個段落失敗時，只要有任一段落判為 app 問題，整次就是 `app`。不確定時選 `app`，寧可多叫一次人，也不要漏掉真問題。
- **已知環境問題清單**：由各 repo 自己維護一份說明檔，放在 repo 內，例如 `.github/e2e-known-env-issues.md`，由腳本讀入 prompt。Android 的初版內容取自 `e2e-prod.yml` 與 `ci-e2e-run.sh` 註解裡的歷史紀錄：
  - 沉浸模式確認提示
  - ANR 對話框搶焦點（`RootViewWithoutFocusException`）
  - ENOSPC → "No connected devices!"
  - GMS 冷開機 SQLite 鎖／system_server contention
  - Gradle 與 emulator 搶資源
  - 鎖區影片誤報
  - iOS 則有 simulator 開機失敗、自架 runner 髒狀態等。
- 修正建議要具體到可執行，例如「在 `ci-e2e-run.sh` 開跑前加 `adb shell settings put …`」，不要泛泛而談。
- log 放在 user message；說明與定義放在 system，讓 prompt 前段穩定。

### 5.4 Log 取材與遮蔽

- Android：
  - `${RUNNER_TEMP}/e2e.log` 尾段
  - `${RUNNER_TEMP}/logcat.txt` 尾段
- iOS：`${RUNNER_TEMP}/e2e.log` 尾段。xcresult 不送。
- 總量上限約 150 KB 文字（估計約 40k token，一次約 US$0.1 上下；**未實測**，實作後以 `usage` 回填）。各檔取尾段的比例留給實作者，原則是失敗段落附近優先。
- 非 UTF-8 位元組：iOS 的 log 已知含有，先轉換或剔除，避免 `jq` 失敗。
- **秘密遮蔽**（必做）：送出前把以下環境變數的值替換成 `***`：
  - `TRUSTNEL_E2E_EMAIL`
  - `TRUSTNEL_E2E_PASSWORD`
  - `TRUSTNEL_E2E_LOCK`
  - `TRUSTNEL_SUPABASE_URL`
  - `TRUSTNEL_SUPABASE_PUBLISHABLE_KEY`
  - `YOUTUBE_API_KEY`／`TRUSTNEL_YOUTUBE_API_KEY`
  - `BEACON_SECRET`
  - 遮蔽清單由 workflow 以環境變數傳入，腳本逐一替換。
  - heartbeat 的 summary fallback（取 e2e.log 最後一行）以同一份清單遮蔽，且先遮蔽再截斷至 200 字。
  - GitHub OIDC JWT 與換到的 access token 只存在腳本變數中，不寫入 log、不寫進輸出檔。

## 6. th-beacon 端改動

### 6.1 `/api/heartbeat` payload（向後相容）

新增兩個選填欄位：

```ts
diagnosis?: {
  category: 'env' | 'app'
  severity: 'P0' | 'P1' | 'P2'
  reason: string
  suggestion: string
  model?: string
}
diagnosisError?: string   // CI 端判讀失敗的原因，例如 "timeout"、"refusal"
```

- 驗證規則：
  - `diagnosis` 不合法（缺欄位、enum 不符）時**丟棄並回 warning，不拒收整包**。理由同 `runUrl`：拒收會讓存活訊號送不出去。
  - `reason` 截到 500 字，`suggestion` 截到 1000 字。
  - `diagnosisError` 截到 200 字。
- 只在 `status: "fail"` 時有意義；`pass` 帶了也忽略。
- `docs/api.md` 要同步更新。

### 6.2 事件正規化與判級

- `normalizeHeartbeatFailure`：
  - `diagnosis.category === 'env'` → `errorType: 'test_failure_env'`，message `Test failed (env): <name>`，fingerprint 為 `heartbeatFingerprint(serviceId, 'test_failure_env', name)`
  - 其餘情況（`app`、無診斷、判讀失敗）→ 沿用 `test_failure`
  - `metadata` 加入 `diagnosis`（或 `diagnosisError`）
  - 順手修正：寫進 metadata 的 `summary` 改用截斷後的值（目前未截斷）
- `CanonicalEvent` 新增選填 `severity?: Severity`：
  - 有值時 `processEvent` 以它取代 `evaluateSeverity` 的結果
  - 其餘流程（ratchet 只升不降、health 推導）不變
  - 有 `diagnosis` 時，normalizer 會填入這個欄位
- **pass 時**同時 resolve `test_failure` 與 `test_failure_env` 兩筆 issue。
- triage 規則表：不必新增 `test_failure_env` 規則，有診斷時一定帶 severity。萬一沒帶，預設 P2，但依 §6.1 env issue 不可能沒帶 diagnosis。

### 6.3 summary 回退文字太空泛（Android、iOS 都改）

**查證結果**
- grep 字串本身沒錯：iOS `scripts/e2e.sh:237` 印的就是 `[e2e] 失敗段落：…`，hosted runner 時期的 8 次失敗都有正確抓到。
- 使用者在 iOS 只看到 `job=failure（e2e.sh 未跑到結尾）`，原因如下：
  - 改用自架 runner（8/26）後，iOS 只失敗過 2026-10-23 那一次（run 39877454337）。
  - 那次 `TRUSTNEL_SUPABASE_PUBLISHABLE_KEY` 是空值，`e2e.sh` 在印出任何段落前就退出了。log 唯一一行是 `找不到 …/trustnel/apps/api/.env（可用 TRUSTNEL_API_ENV 指定，或直接以 TRUSTNEL_SUPABASE_* 注入）`。
- 結論：這類「提早退出」的失敗（環境變數缺少、模擬器建不起來、前置健檢失敗），回退文字完全看不出原因。

**修法**
- 兩個 repo 的 heartbeat step 都改：抓不到段落結論時，改用 `e2e.log` 最後一行非空內容組成 summary：
  - 格式：`job=<status>：<最後一行>`
  - 先去掉 ANSI 色碼，截到 200 字
  - `e2e.log` 不存在或內容為空時，維持原本的回退文字
- known-env-issues 清單加一條：「必要環境變數／secret 為空（例如 secret 改名後漏補）→ env、P1（整個 e2e 跑不起來）」。

### 6.4 通知

- `NOTIFY_MIN_SEVERITY` 由 `'P1'` 改為 `'P2'`。
- Discord 標題：有診斷時改為 `[P?] <服務名> — 環境問題` 或 `[P?] <服務名> — app 問題`；無診斷時維持 `errorType`。
- 新增欄位，沿用 `extractNotifyDetails` 白名單機制：
  - 「判定原因」← `diagnosis.reason`
  - 「修正建議」← `diagnosis.suggestion`
  - 「AI 判讀失敗」← `diagnosisError`
- **顏色**：
  - 用這一次 event 的 severity（Claude 給的），而非 issue 經 ratchet 後的歷史最高值。理由：每天的判讀可能不同，訊息應反映這一次的狀況。
  - issue 本身的 severity 照 ratchet 規則只升不降，dashboard 顯示的是最差值。
  - 無診斷時，event 沒有 severity，維持用 issue severity（現行行為）。
- 冷卻／升級判斷（`shouldNotify`）的邏輯不變，但輸入的 severity 與顏色同源：
  - 有 event severity 時，用它判斷門檻、升級，並寫進 `notifications.severity`
  - 沒有時，用 issue severity
  - 每日一跑，間隔遠超 30 分鐘冷卻，所以每次失敗都會發。

### 6.5 健康度（dashboard 燈號）

- 不改 `deriveHealth`。env issue 和其他 issue 一樣，依 severity 映射：P0 → down、P1 → degraded、P2 → healthy。
- 理由：
  - Claude 只有在「環境壞到整個 e2e 失去監控價值」時才會給 env P1。這時把服務標成 degraded 是對的。
  - issue severity 受 ratchet 影響只升不降，且 reopen 不重置：曾被判 P1 的 issue，之後即使當次為 P2，在 health window 內仍顯示 degraded。Discord 顏色不受影響（取當次 severity）。此為已接受的取捨。
  - 每日 e2e 的 issue 在超過 `healthWindowMinutes` 後就不再計入燈號，影響本來就是短暫的。

### 6.6 既有資料

- 線上現有的 `test_failure` issue（2026-10-23 查詢時全部為 `resolved`）不做遷移，也不清理。
- 之後 app 類失敗會沿用同一個 fingerprint 重開，並保留歷史 severity（ratchet）。Discord 顏色改用 event severity，所以不受影響。
- pass 時 resolve 兩筆 issue，沿用現有 `resolveIssueByFingerprint` 的語意：只動 `open` 與 `acknowledged`，不碰 `ignored`。

## 7. 部署順序

1. th-beacon 先上線：payload 相容、新 errorType、通知門檻、Discord 欄位。舊 CI 不受影響。
2. 使用者在 Console 完成 WIF 設定（§5.5），把 rule／org／service account ID 設成兩個 repo 的 variables。兩個 CI repo 加 `e2e-known-env-issues.md`、複製兩支腳本，workflow 加判讀 step 與 `permissions`。
3. 用 `workflow_dispatch` 在各平台各觸發一次真實失敗（或以已知失敗的 log 本地跑腳本），確認 Discord 訊息與 dashboard issue 正確。

## 8. 驗收

- th-beacon 單元測試覆蓋以下情境：
  - payload 解析：合法 diagnosis、缺欄位、enum 錯誤 → warning、舊格式
  - env／app／無診斷時 errorType、fingerprint 的分流
  - event severity 覆寫規則表，且 ratchet 仍生效
  - pass 時兩筆 issue 都被 resolve
  - P2 會發通知
  - Discord 標題、欄位、顏色取自 event severity
- `pnpm typecheck`、`pnpm test`、`pnpm test:integration`（本地 stack）通過。
- 診斷腳本以 Android 10/16–10/21 那幾輪的真實 log 試跑：判為 `env`，並提到沉浸模式提示。
- 模擬 API 失敗（換 token 回 401，或 Messages API 回 500）時：腳本 exit 0、心跳照送、Discord 出現「AI 判讀失敗」、維持 P1。
- 檢查送出的 request body，確認不含任何秘密值。

## 9. 留給實作者決定

- prompt 的確切措辭與 few-shot（若需要）。
- log 尾段的取法與 Android 兩檔的比例。
- 腳本的參數介面與檔名細節；heartbeat 腳本第 5 參數的確切形式。
- Discord 欄位的排列順序。
- 是否在心跳 response body 回傳採用的 diagnosis（方便 CI log 除錯）。

## 10. 我（Claude）替使用者做的決定（使用者可推翻）

- 共用腳本以 bash＋curl＋jq 實作，源頭放在 th-beacon `scripts/`。
- `diagnosis` 不合法時丟棄並回 warning，不拒收。
- Discord 顏色採用「這一次」event 的 severity，而非 issue 的歷史最高值。
- 不確定時判 `app`；多段落中有任一 app 問題，整次判 `app`。
- 已知環境問題清單由各 CI repo 自己維護，不放 th-beacon。
- log 上限約 150 KB；成本估算未實測。
- 判讀 step 條件改為 `failure() || cancelled()`，涵蓋逾時的情況。
- `shouldNotify` 與 `notifications.severity` 改用和 Discord 顏色同一個來源（有 event severity 就用它）。
- 不改健康度推導；env issue 依 severity 影響燈號。
- 不在 th-beacon 端設 severity 下限：例如 app 問題被 Claude 判成 P2，就照 P2 灰色發送。理由是「嚴重度交給 Claude」是使用者的決定，而且 P2 現在也會發 Discord，不會漏掉。CI 持有的 HMAC 金鑰本來就是信任邊界，不額外防範 CI 自己壓低嚴重度。
- 既有的 `test_failure` issue 不遷移。

> 已查證：`output_config: {format: {type: "json_schema", schema}}` 是目前 Messages API 的結構化輸出參數，`claude-sonnet-5-5` 支援（依 claude-api skill 文件，2026-10 快取版）。schema 不支援 `maxLength`。實作時仍須以真實呼叫確認一次。
