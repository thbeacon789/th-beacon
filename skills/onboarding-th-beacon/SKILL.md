---
name: onboarding-th-beacon
description: Use when connecting a service or repo to th-beacon (公司監控平台, th-beacon.vercel.app) — 接上監控、登記服務或測試用服務、設定告警負責人（Discord tag）、回報 CI／nightly／e2e 測試結果、心跳 heartbeat、推送錯誤到 /api/ingest、送測試告警、BEACON_SECRET、或 th-beacon 回 401／404 的接入問題.
---

# 接入 th-beacon

## 概觀

th-beacon 是集中式監控平台，線上網址 **`https://th-beacon.vercel.app`**。服務透過下列端點回報，皆用每服務一把的 HMAC 金鑰驗證：

- `POST /api/heartbeat`：CI 每次跑完都回報 pass／fail，用來證明排程有在跑
- `POST /api/ingest`：推送錯誤事件
- `POST /api/ai-usage`：回報 AI 用量（token 或金額），選填
- `POST /api/ai-fix`：回報 AI 修復 PR 的結果，選填（由 `ai-fix-e2e-failure.sh` 自動呼叫，接入者不必手寫）

**契約不要猜。** headers、簽章算法、payload、回應碼都寫在本目錄的 `api-reference.md`，簽章細節錯一點就是 401。回報用的 script 一律用 th-beacon 現成的（workflow 執行時 checkout 釘選版本，見「接線」），不要自己重寫，也不要複製進目標 repo。

## 分工：人做登記，你做接線

登記服務、產生金鑰只能在 dashboard 的 `/services` 頁面做（需 Google 登入＋白名單）。沒有 API 可以登記，也不要嘗試直接寫 DB。

| 步驟 | 誰做 | 內容 |
| --- | --- | --- |
| 1 | 使用者 | 到 `https://th-beacon.vercel.app/services` 登記：服務名稱、服務說明、**負責人 Discord ID**（可多人），並**勾選登記心跳**（名稱、interval、grace）。金鑰只顯示一次 |
| 2 | 使用者 | 在**自己的終端機**執行 `gh secret set BEACON_SECRET --repo <owner>/<repo>`（會隱藏輸入），或到 GitHub 網頁設定 |
| 3 | 你＋使用者 | 建 deploy key 並設 `BEACON_SCRIPTS_DEPLOY_KEY`、在 workflow 加 th-beacon checkout 並改回報步驟（見下） |
| 4 | 你＋使用者 | 用 `gh workflow run` 觸發一次，`gh run view --log` 確認回報步驟收到 200 |

一開始就把步驟 1、2 交代清楚，並把你建議的值一起給：服務名稱、心跳名稱，以及 interval／grace（daily 排程建議 `86400`／`3600`）。workflow 裡的名稱必須與登記的**完全相同**。

### 負責人與 Discord 告警

負責人 Discord ID 是**數字 ID**（17–20 位），不是使用者名稱；可填多人（最多 10 個，以逗號、空白或換行分隔）：Discord「使用者設定 → 進階」開啟開發者模式，對該成員按右鍵 →「複製使用者 ID」。留空也能登記，但告警就不會 tag 任何人；之後可在 `/services` 的服務卡片上補填或修改。

接好之後的告警長這樣，登記時一併告訴使用者：

- 告警發到共用告警頻道，**每一則都 tag 全部負責人**，標題連到該筆 issue 頁面。
- 告警附「✋ 確認」「✅ 已解決」按鈕，頻道內任何人都能按。確認與解決的紀錄發在該告警開出的**討論串**裡；確認後冷卻期滿只靜默更新次數、不再 tag，只有嚴重度升級才再 tag。
- 服務恢復（輪詢或心跳轉 pass）會自動解決並在討論串註記；同一問題解決後再發生，算新事故，重新告警並回覆指向上一則。

**金鑰不經過對話。** 金鑰只走兩條路：使用者自己的終端機（`gh secret set` 會隱藏輸入），或剪貼簿（`$(pbpaste)`，指令與輸出都不含金鑰本身）。不要請使用者把金鑰貼進對話，也不要讓金鑰字面出現在 `!` 前綴指令裡（會進對話紀錄）。如果使用者還是貼了，提醒他設完 secret 後到 `/services` 按「重新產生」換一把。

## 接線

1. **腳本在 workflow 執行時 checkout th-beacon 的釘選 commit 取得，不複製進目標 repo。** 腳本的 canonical 只在 th-beacon，目標 repo 的 `scripts/` 不放它們的副本，也就沒有版本漂移。步驟：
   - (a) **deploy key**：為目標 repo 在 `thbeacon789/th-beacon` 新增一把**唯讀**的 deploy key。使用者在自己的終端機產生：`ssh-keygen -t ed25519 -N "" -f <暫存檔>`，公鑰貼到 th-beacon 的 Settings → Deploy keys，**不勾** Allow write access。deploy key 只對單一 repo 有效、不可跨 repo 重用，**每個目標 repo 各一把**。
   - (b) **secret**：私鑰存入目標 repo 的 secret `BEACON_SCRIPTS_DEPLOY_KEY`（例如 `gh secret set BEACON_SCRIPTS_DEPLOY_KEY --repo <owner>/<repo> < <暫存檔>`，由使用者在自己的終端機執行），之後**刪除暫存檔**。私鑰不經過對話。
   - (c) **checkout 步驟**：在目標 repo 自己的 checkout **之後**（順序不可反：之後若再對根目錄 checkout，`clean` 會把 `.beacon/` 連同巢狀 repo 一起刪掉），加入：

```yaml
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - name: Checkout th-beacon scripts
        uses: actions/checkout@v4
        with:
          repository: thbeacon789/th-beacon
          ref: <完整 40 碼 commit SHA>      # 字面值，見 (e)
          ssh-key: ${{ secrets.BEACON_SCRIPTS_DEPLOY_KEY }}
          path: .beacon
          sparse-checkout: scripts
          fetch-depth: 1
          persist-credentials: false
```

   腳本一律以 `bash ./.beacon/scripts/<name>.sh` 呼叫（不依賴 sparse checkout 後的執行位元）。cwd 仍是目標 repo 根，其他相對路徑不變。若服務執行期也要推錯誤（不是 CI 測試結果），改用 `report-to-beacon.sh` 並以第 3 參數指定 `errorType`（省略時為 `test_failure`，執行期錯誤不要省略）。`path` 必須在 workspace 內，所以 th-beacon 不能放在目標 repo 工作樹之外。
   - (d) **清掉舊複製品**：目標 repo 若已有 th-beacon 腳本的複製品（`heartbeat-to-beacon.sh`、`diagnose-e2e-failure.sh`、`report-to-beacon.sh` 等），一併刪除並確認 `.github`、`scripts` 內沒有其他引用；目標 repo 自己的腳本不動。
   - (e) **SHA 更新程序**：`ref` 一律寫完整 40 碼 commit SHA，**寫在 workflow 檔字面值，不放 repo variable**（讓變更進 PR diff 受審查）。該 commit 必須已存在於 th-beacon 的遠端。th-beacon 改腳本並 push 後，取新 SHA：`git ls-remote git@github.com:thbeacon789/th-beacon.git refs/heads/main`（或 `gh api repos/thbeacon789/th-beacon/commits/main --jq .sha`），再人工修改各目標 repo workflow 內的 `ref:` 並走 PR 審查。沒有自動更新機制（Dependabot 只管 `uses:`），忘了更新就是繼續跑舊腳本。
   - **待驗證（尚未在 CI 實跑確認，以第一個接入的 repo 實測為準）**：deploy key＋`fetch-depth: 1`＋指定 SHA＋`sparse-checkout` 這個組合對私有 repo 是否成功（失敗時退路是 `fetch-depth: 0`）；自架 runner 上 checkout 寫入 `$RUNNER_TEMP` 的金鑰暫存檔，在 job 被取消或 runner 被殺時是否被清理（action 的 post 步驟負責刪，不保證一定執行；驗證前，自架 runner 上的 job 視為有金鑰殘留風險，建議改用 ephemeral runner 或在 job 結尾加 `if: always()` 的清理步驟）；`.beacon/` 這個未追蹤目錄是否影響目標 repo 的建置工具。
   - **陷阱**：`persist-credentials: false` 兩個 checkout 都要加；deploy key 無到期日、無 passphrase，輪替靠人；`GITHUB_TOKEN` 讀不到另一個擁有者的私有 repo，所以跨擁有者只能用 deploy key。fork PR 拿不到 secret，所以回報步驟只用在排程或手動觸發的 job。
   - 只有在**完全無法 checkout th-beacon**（例如接入方拿不到 deploy key）時才退而複製：本目錄的 script 是 symlink，須用 `cp -L <本目錄>/scripts/<檔名> <目標>/scripts/` 逐檔複製（不要 `cp -R`），並自行承擔版本漂移；這不是預設做法，**須先徵得使用者同意，agent 不得自行決定改用**。
2. 在測試 job 的最後加上回報步驟：

```yaml
      - name: Report heartbeat to th-beacon
        if: always()   # pass 和 fail 都要送；沒送才會觸發逾期告警
        env:
          BEACON_URL: https://th-beacon.vercel.app/api/heartbeat
          BEACON_SERVICE: order-api            # 與 /services 登記的服務名稱完全相同
          BEACON_SECRET: ${{ secrets.BEACON_SECRET }}
        run: |
          bash ./.beacon/scripts/heartbeat-to-beacon.sh nightly-e2e \
            "${{ job.status == 'success' && 'pass' || 'fail' }}" \
            "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

- 回報失敗要讓 step 變紅（script 內建 `curl --fail-with-body`）。**不要**包 `|| true`，也不要吞掉錯誤，否則接錯了只會變成每天的「心跳逾期」假告警，查不到原因。
- 不要自己加重試迴圈：fail 重送會累計到同一筆 issue 的 count。
- 第 4 參數 `summary` 選填，會出現在告警內容裡。若能從測試輸出取得失敗數（例如 `"3 of 120 failed"`），建議傳入。
- 第 5 參數（AI 診斷 `diagnosis`）選填，使用者沒要求就不要接。要接時，用 checkout 出來的 `./.beacon/scripts/diagnose-e2e-failure.sh` 產生診斷檔（同一份釘選版本，不要複製或修改）。它需要 Anthropic WIF 認證，所需環境變數見 script 開頭註解。
- **log 太大時用 signals（2026-11-25 起）**：diagnose 送模型的 log 有位元組上限，超量只留頭＋尾，真因落在中間會被切掉。先用 `./.beacon/scripts/extract-e2e-signals.sh <android|ios> <log 檔...> > signals.txt` 從完整 log 確定性萃取（例外堆疊去重、時間軸、系統殺進程事件，≤ 30KB），再把它排在 diagnose 的第一個 log 參數，並設 `DIAGNOSE_PRIORITY_FILES="${RUNNER_TEMP}/signals.txt"`（以 `:` 分隔的完整路徑字串）保證整份送出；其餘檔分剩餘預算。android 傳 logcat（adb threadtime 格式）與 e2e.log，ios 傳 xcodebuild 文字 log；App 套件名預設 `com.trustnel.app.debug`，其他 repo 用 `E2E_SIGNALS_PACKAGE`／`E2E_SIGNALS_APP_PREFIX` 覆寫。
- 要記錄 AI 花費時，diagnose 步驟另設 `BEACON_AI_USAGE_URL`（＋同一組 `BEACON_SERVICE`／`BEACON_SECRET`）；不設則不回報，不影響診斷。
- `job.status` 為 `cancelled` 時會送出 fail。這是刻意的：nightly 被取消就代表沒有測試結果，需要人看。
- 回報 step 失敗會讓整個 job 變紅，這也是刻意的：接線出錯必須看得見。
- ubuntu runner 預設就有 `jq`、`openssl`、`curl`。

## AI 修復 PR（選用）

E2E 失敗且 AI 判讀認為是 app 程式碼問題時，CI 的 `ai-fix` job 嘗試改檔、開修復 PR，並把結果回報 th-beacon（`POST /api/ai-fix`，契約見 `api-reference.md` §8；issue 頁會顯示、告警討論串會通知負責人）。使用者沒要求就不要接。

**前置條件**
- 已接好 AI 判讀（`diagnose-e2e-failure.sh`，其輸出含 `needsCodeChange`）與心跳，且上述 th-beacon checkout 已就緒。心跳名稱對應的 `test_failure` issue 是回報的對象。
- GitHub App（例如公司已建的 `trustnel-ai-fix`，或自建）已安裝到目標 repo：Repository permissions 只給 Contents、Pull requests 的讀寫，**不含 Workflows**。
- 目標 repo secrets：`AI_FIX_APP_CLIENT_ID`、`AI_FIX_APP_PRIVATE_KEY`（另需前述 `BEACON_SCRIPTS_DEPLOY_KEY`、`BEACON_SECRET`）；variable：`AI_FIX_REVIEWER`（PR 審核者的 GitHub 帳號，須有該 repo 寫入權限）。
- 停用開關：建立 repo variable `AI_FIX_ENABLED`，值設為 `true` 才啟用 `ai-fix` job（不存在＝關閉）。建議等 th-beacon 部署完成、對線上 `/api/ai-fix` 的煙霧請求確認不是 307（無 active issue 時預期 404 `no_active_issue`）之後再建立。
- label `ai-fix` **必須先建**：缺 label 時腳本的 `gh pr create` 會失敗。
- Anthropic WIF 認證（診斷已在用）；federation rule 的 subject 只允許 `main`，所以 `ai-fix` 要在 `main` 上才換得到權杖，在測試分支上會 401，除非另建該分支的臨時 rule。

**job 配置**：兩段 YAML 皆以已接入的 repo 為範本（見各接入 repo 的 `.github/workflows/e2e-prod.yml`），尖括號為佔位符，`<40 碼 SHA>` 與 th-beacon checkout 的 `ref` 必須同值。

(1) E2E job 側（`<e2e job id>` 為跑 E2E 的 job；Diagnose 與 Report heartbeat 步驟沿用上面的寫法，只補下列差異）：

```yaml
  <e2e job id>:
    # needs_fix 由 needs-fix step 設定：判讀為 app 類且需改程式時為 'true'
    outputs:
      needs_fix: ${{ steps.needs-fix.outputs.needs_fix }}
    permissions:
      id-token: write      # 判讀與 ai-fix 以 GitHub OIDC 換 Anthropic 憑證（WIF）
      contents: read
    steps:
      # ...checkout、th-beacon checkout、E2E 步驟...
      - name: Diagnose failure with Claude
        if: failure() || cancelled()
        continue-on-error: true
        env:
          # ...原本的 ANTHROPIC_*（WIF）、DIAGNOSE_*、BEACON_* env...
          DIAGNOSE_REDACTED_OUT: ${{ runner.temp }}/ai-fix-redacted.log   # 新增：遮蔽後的 log，供 ai-fix 當輸入
          DIAGNOSE_REDACTED_FULL_DIR: ${{ runner.temp }}/ai-fix-full-logs   # 選填：每個輸入檔遮蔽後的「完整」內容，供 ai-fix 的 agent Grep（內嵌 log 只是切片）
        run: |
          ./.beacon/scripts/diagnose-e2e-failure.sh <platform> <known-env-issues.md> \
            "${RUNNER_TEMP}/diagnosis.json" <log 檔...>

      # 判讀為「app 類且需要改程式」才讓 ai-fix 接手；只讀 diagnosis.json，檔案不存在或解析失敗視為不成立
      - name: Decide whether AI fix is needed
        id: needs-fix
        if: failure() || cancelled()
        continue-on-error: true
        run: |
          if jq -e '.category == "app" and .needsCodeChange == true' "${RUNNER_TEMP}/diagnosis.json" >/dev/null 2>&1; then
            echo "needs_fix=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Upload AI fix input
        if: (failure() || cancelled()) && steps.needs-fix.outputs.needs_fix == 'true'
        uses: actions/upload-artifact@v4
        with:
          name: ai-fix-input
          path: |
            ${{ runner.temp }}/ai-fix-redacted.log
            ${{ runner.temp }}/diagnosis.json
            ${{ runner.temp }}/ai-fix-full-logs   # 選填：有設 DIAGNOSE_REDACTED_FULL_DIR 才需要（目錄；upload-artifact 會保留其下檔案）
          retention-days: 7
          if-no-files-found: ignore

      # ...Report heartbeat（if: always()）...
```

**陷阱（原因）**：E2E job 中所有「失敗後才執行」的 step（判讀、needs-fix、上傳 artifact）的 `if:` 都必須顯式帶 `failure() || cancelled()`。step 的 `if` 沒有狀態函式時隱含 `success()`，job 失敗時整個 step 會被跳過；上傳 step 的 `needs_fix == 'true'` 只在 job 已失敗時才成立，漏寫狀態函式會永遠跳過。`needs-fix` 只寫字面值 `needs_fix=true`，不內插任何不可信內容。

(2) 完整的 `ai-fix` job（`ubuntu-latest`，兩個平台都一樣；`<heartbeat-name>`、`<beacon-service>` 與登記一致）：

```yaml
  ai-fix:
    needs: <e2e job id>
    # 用 !cancelled() 而非 always()：手動取消整個 run 時不應再啟動修復；上游失敗時照常執行。
    # 必須包 ${{ }}：以 ! 開頭的純字串在 YAML 會被誤解析。
    # repo variable AI_FIX_ENABLED 設為 true 才啟用；要緊急停用就把它改掉或刪除，不必改 workflow。
    if: ${{ !cancelled() && vars.AI_FIX_ENABLED == 'true' && needs.<e2e job id>.outputs.needs_fix == 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      id-token: write
      contents: read
      pull-requests: read   # 失敗回報 step 以唯讀查詢確認沒有 open 的 AI PR，才補報 failed
    steps:
      # 目標 repo 與 th-beacon 並列、不可巢狀：腳本要求 cwd（app/）是乾淨的 repo 根，且 agent 被限制在 cwd 內
      - name: Checkout app
        uses: actions/checkout@v4
        with:
          path: app
          ref: ${{ github.sha }}
          persist-credentials: false

      - name: Checkout th-beacon scripts      # 參數同上面 (c)，只有 path 不同
        uses: actions/checkout@v4
        with:
          repository: thbeacon789/th-beacon
          ref: <40 碼 SHA>
          ssh-key: ${{ secrets.BEACON_SCRIPTS_DEPLOY_KEY }}
          path: beacon
          sparse-checkout: scripts
          fetch-depth: 1
          persist-credentials: false

      # 不可下載進 app/，否則腳本的「工作樹乾淨」檢查會失敗
      - uses: actions/download-artifact@v4
        with:
          name: ai-fix-input
          path: ${{ runner.temp }}/ai-fix-input

      # 釘選 CLI 版本並關閉自動更新，避免 agent 行為隨上游漂移（版本以已接入 repo 的 workflow 為準）
      - name: Install Claude Code CLI
        env:
          DISABLE_AUTOUPDATER: "1"
        run: npm install -g @anthropic-ai/claude-code@2.1.325

      - id: app-token
        uses: actions/create-github-app-token@v3
        with:
          client-id: ${{ secrets.AI_FIX_APP_CLIENT_ID }}
          private-key: ${{ secrets.AI_FIX_APP_PRIVATE_KEY }}
          permission-contents: write
          permission-pull-requests: write

      - name: Resolve bot user id
        id: bot
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          APP_SLUG: ${{ steps.app-token.outputs.app-slug }}
        run: |
          ID="$(gh api "/users/${APP_SLUG}[bot]" --jq .id)" || ID=""
          if ! [[ "$ID" =~ ^[0-9]+$ ]]; then
            echo "無法取得 bot user id（取得值：'${ID}'）" >&2
            exit 1
          fi
          echo "user-id=${ID}" >> "$GITHUB_OUTPUT"

      - name: AI fix
        working-directory: app
        env:
          DISABLE_AUTOUPDATER: "1"
          GH_TOKEN: ${{ steps.app-token.outputs.token }}
          BASE_BRANCH: ${{ github.ref_name }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          AI_FIX_REVIEWER: ${{ vars.AI_FIX_REVIEWER }}
          AI_FIX_APP_SLUG: ${{ steps.app-token.outputs.app-slug }}
          AI_FIX_APP_USER_ID: ${{ steps.bot.outputs.user-id }}
          AI_FIX_DRY_RUN: ${{ inputs.ai_fix_dry_run && '1' || '' }}
          ANTHROPIC_FEDERATION_RULE_ID: ${{ vars.ANTHROPIC_FEDERATION_RULE_ID }}
          ANTHROPIC_ORGANIZATION_ID: ${{ vars.ANTHROPIC_ORGANIZATION_ID }}
          ANTHROPIC_SERVICE_ACCOUNT_ID: ${{ vars.ANTHROPIC_SERVICE_ACCOUNT_ID }}
          ANTHROPIC_WORKSPACE_ID: ${{ vars.ANTHROPIC_WORKSPACE_ID }}
          BEACON_BASE_URL: ${{ vars.BEACON_BASE_URL }}
          BEACON_SERVICE: <beacon-service>
          BEACON_SECRET: ${{ secrets.BEACON_SECRET }}
        run: |
          bash "$GITHUB_WORKSPACE/beacon/scripts/ai-fix-e2e-failure.sh" <platform> <heartbeat-name> \
            <known-env-issues.md 相對 app/ 的路徑> \
            "$RUNNER_TEMP/ai-fix-input/diagnosis.json" \
            "$RUNNER_TEMP/ai-fix-input/ai-fix-redacted.log" \
            "$RUNNER_TEMP/ai-fix-input/ai-fix-full-logs"   # 選填第 6 參數：完整 log 目錄；腳本複製到 .ai-fix-logs/ 讓 agent Grep，用完即刪、不進 commit

      # job 在腳本開始前就失敗（App 權杖、artifact 下載、bot id 解析、腳本缺 env）時，th-beacon 否則收不到任何回報。
      # 以「只回報失敗」模式補報；不設 working-directory（app/ 可能不存在）。
      # 已知限制：th-beacon checkout 本身失敗時腳本不存在，無法回報。
      # 腳本會先確認該分支沒有 open 的 AI PR 才回報（有、或查不到都不回報，免得蓋掉仍有效的 pr_opened）。
      - name: Report ai-fix job failure to th-beacon
        if: ${{ failure() }}
        continue-on-error: true
        env:
          GH_TOKEN: ${{ github.token }}
          AI_FIX_DRY_RUN: ${{ inputs.ai_fix_dry_run && '1' || '' }}
          BEACON_BASE_URL: ${{ vars.BEACON_BASE_URL }}
          BEACON_SERVICE: <beacon-service>
          BEACON_SECRET: ${{ secrets.BEACON_SECRET }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          SCRIPT="$GITHUB_WORKSPACE/beacon/scripts/ai-fix-e2e-failure.sh"
          if [ ! -f "$SCRIPT" ]; then
            echo "找不到 $SCRIPT（th-beacon checkout 可能失敗），無法回報"
            exit 0
          fi
          AI_FIX_REPORT_ONLY=failed bash "$SCRIPT" <heartbeat-name>
```

- `ANTHROPIC_*` 四個值來自目標 repo 的 repository variables（診斷步驟已在用同一組，WIF 由公司的 Anthropic 組織設定，不是 secret）；`BEACON_BASE_URL` 也是 variable，`BEACON_SECRET` 沿用心跳那把。`<known-env-issues.md>` 是目標 repo 已有的已知環境問題清單，路徑相對 `app/`。
- 安裝 CLI 放在產生 App 權杖**之前**；bot user id 必須以 `^[0-9]+$` 驗證、失敗即中止（它會組成 commit 作者 email）。所有 checkout 都 `persist-credentials: false`；push 的憑證由腳本自行處理，**不需要 `gh auth setup-git`**。
- 此 job **不得**帶入任何 E2E 帳密 secret（`TRUSTNEL_*` 之類）；`GH_TOKEN` 只給腳本。`run:` 內不用 `${{ }}` 內插不可信值，一律經 `env:`。
- `create-github-app-token@v3` 不給 `owner`／`repositories` 即只含當前 repo。若 actionlint 對 `client-id` 報未知輸入，是其中繼資料過舊的誤報。
- 腳本的必要 env 與回報用 env（缺任一 `BEACON_*` 則不回報）以腳本檔頭註解為準；`workflow_dispatch` 需有 boolean input `ai_fix_dry_run`（見下）。

**乾跑**：手動觸發時設 `AI_FIX_DRY_RUN=1`（建議在 `workflow_dispatch` 加 boolean input `ai_fix_dry_run`）。乾跑**會呼叫模型**（依預設最高可能花到預算上限 `AI_FIX_MAX_BUDGET_USD`，預設 US$5）與 GitHub 的唯讀查詢（`gh pr list`），只是不 push、不開 PR、不回報 th-beacon，所以這筆花費不會出現在 `/ai-stats`。用來驗證 checkout、權杖、環境接線與 agent 產出的 diff；第一次接入務必先乾跑。

**如何停用**：首選把 repo variable `AI_FIX_ENABLED` 改成非 `true` 或刪除（立即生效，不必改 workflow）；備援是把 `ai-fix` job 的 `if` 改為 `false`。伺服器端不需要回滾：`/api/ai-fix` 只寫 `ai_fix_*` 四欄，不影響告警流程。

**選填 env（用預設值即可）**：`AI_FIX_AGENT_TIMEOUT_SEC`（agent 逾時，預設 1500 秒）、`AI_FIX_JWT_REFRESH_SEC`（agent 執行期間重取 OIDC JWT 的間隔，預設 240 秒；federation rule 的權杖壽命 600 秒，agent 可能跑更久）。

**待驗證**：agent 的權限旗標（唯讀搜尋範圍、寫入限制）在 CI 上的實際行為尚未實跑確認，接入後第一次實跑要檢查越界檢查與 PR 內容。

**心跳 fail 已經會告警**，一般不需要再推 ingest。只有服務在執行期（非 CI）要回報錯誤時才用 `/api/ingest`。此時 `message` 必須是固定字串，次數、時間、URL 一律放進 `metadata`，否則每次回報都會長出一筆新 issue。

## 測試用服務（驗證告警流程）

使用者只想看告警長怎樣、或驗證 Discord 按鈕時，登記一個獨立的測試服務，別拿正式服務送假錯誤（會弄髒它的健康燈號與 issue 紀錄）：

1. 使用者到 `/services` 登記，名稱建議 `beacon-selftest`，填負責人 Discord ID，**不勾心跳**（沒有 CI，勾了會每天逾期告警）。金鑰顯示後**複製到剪貼簿**。
2. 使用者在 th-beacon repo 根目錄用 `!` 前綴執行（本機試跑，直接用 repo 內的 `scripts/`；若在已 checkout 腳本的目標 repo 本機試跑，路徑換成 `./.beacon/scripts/report-to-beacon.sh`），金鑰從剪貼簿讀：

```bash
! BEACON_URL=https://th-beacon.vercel.app/api/ingest BEACON_SERVICE=beacon-selftest BEACON_SECRET="$(pbpaste)" bash scripts/report-to-beacon.sh "Discord 告警流程測試" "" selftest
```

3. 回 `201` 且帶 `issueId` 即送達（`triage: "deferred"` 代表判級與通知在回應後才跑，等幾秒）。請使用者到告警頻道依序確認：被 tag、按「確認」出現討論串紀錄、按「已解決」後按鈕消失。
4. 要再送一次新告警，換一個 `message`（同 message 會聚合到同一筆 issue，冷卻期內不重發）。

## 回應碼速查

| 狀態 | 原因 |
| --- | --- |
| 401 | 服務名稱錯或未登記、金鑰錯或沒設、簽到的 body 與送出的不同、runner 時鐘偏差超過 5 分鐘 |
| 404 | 心跳名稱沒登記，或拼法不同（請使用者到 `/services` 補登記） |
| 422 | `name`／`status` 不合法（status 只接受 `pass`／`fail`） |
| 200 | heartbeat 成功；ingest 成功為 201 |

其他欄位（`summary`、AI 診斷 `diagnosis`）以及完整的錯誤表，見 `api-reference.md`。

## 維護

本 skill 的版控位置在 th-beacon repo 的 `skills/onboarding-th-beacon/`，全域 `~/.claude/skills/onboarding-th-beacon` 是指向它的 symlink。`api-reference.md` 與 `scripts/*` 也是 symlink，分別指向 repo 的 `docs/api.md` 與 `scripts/`。修改契約時改原檔即可，不要在這裡另存副本。
