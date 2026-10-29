---
name: onboarding-th-beacon
description: Use when connecting a service or repo to th-beacon (公司監控平台, th-beacon.vercel.app) — 接上監控、回報 CI／nightly／e2e 測試結果、心跳 heartbeat、推送錯誤到 /api/ingest、BEACON_SECRET、或 th-beacon 回 401／404 的接入問題.
---

# 接入 th-beacon

## 概觀

th-beacon 是集中式監控平台，線上網址 **`https://th-beacon.vercel.app`**。服務透過兩個端點回報，兩者都用每服務一把的 HMAC 金鑰驗證：

- `POST /api/heartbeat`：CI 每次跑完都回報 pass／fail，用來證明排程有在跑
- `POST /api/ingest`：推送錯誤事件

**契約不要猜。** headers、簽章算法、payload、回應碼都寫在本目錄的 `api-reference.md`，簽章細節錯一點就是 401。回報用的 script 也直接複製本目錄現成的，不要自己重寫。

## 分工：人做登記，你做接線

登記服務、產生金鑰只能在 dashboard 的 `/services` 頁面做（需 Google 登入＋白名單）。沒有 API 可以登記，也不要嘗試直接寫 DB。

| 步驟 | 誰做 | 內容 |
| --- | --- | --- |
| 1 | 使用者 | 到 `https://th-beacon.vercel.app/services` 登記服務名稱，**同時勾選登記心跳**（名稱、interval、grace）。金鑰只顯示一次 |
| 2 | 使用者 | 在**自己的終端機**執行 `gh secret set BEACON_SECRET --repo <owner>/<repo>`（會隱藏輸入），或到 GitHub 網頁設定 |
| 3 | 你 | 複製 script、改 workflow（見下） |
| 4 | 你＋使用者 | 用 `gh workflow run` 觸發一次，`gh run view --log` 確認回報步驟收到 200 |

一開始就把步驟 1、2 交代清楚，並把你建議的值一起給：服務名稱、心跳名稱，以及 interval／grace（daily 排程建議 `86400`／`3600`）。workflow 裡的名稱必須與登記的**完全相同**。

**金鑰不經過對話。** 不要請使用者把金鑰貼進對話，也不要用 `!` 前綴執行帶金鑰的指令（輸出會進對話紀錄）。如果使用者還是貼了，提醒他設完 secret 後到 `/services` 按「重新產生」換一把。

## 接線

1. 把本目錄的 `scripts/heartbeat-to-beacon.sh` 複製到目標 repo 的 `scripts/`。若服務執行期也要推錯誤（不是 CI 測試結果），一併複製 `report-to-beacon.sh`，並用第 3 參數指定 `errorType`（省略時為 `test_failure`，執行期錯誤不要省略）。本目錄的 script 是 symlink，複製時一律用 `cp -L <本目錄>/scripts/<檔名> scripts/` 逐檔複製，不要 `cp -R` 整個目錄（會複製成失效的 symlink）。複製後用 `test ! -L scripts/<檔名>` 確認是實體檔。執行時一律用 `bash scripts/xxx.sh` 呼叫。
2. 在測試 job 的最後加上回報步驟：

```yaml
      - name: Report heartbeat to th-beacon
        if: always()   # pass 和 fail 都要送；沒送才會觸發逾期告警
        env:
          BEACON_URL: https://th-beacon.vercel.app/api/heartbeat
          BEACON_SERVICE: order-api            # 與 /services 登記的服務名稱完全相同
          BEACON_SECRET: ${{ secrets.BEACON_SECRET }}
        run: |
          bash scripts/heartbeat-to-beacon.sh nightly-e2e \
            "${{ job.status == 'success' && 'pass' || 'fail' }}" \
            "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

- 回報失敗要讓 step 變紅（script 內建 `curl --fail-with-body`）。**不要**包 `|| true`，也不要吞掉錯誤，否則接錯了只會變成每天的「心跳逾期」假告警，查不到原因。
- 不要自己加重試迴圈：fail 重送會累計到同一筆 issue 的 count。
- 第 4 參數 `summary` 選填，會出現在告警內容裡。若能從測試輸出取得失敗數（例如 `"3 of 120 failed"`），建議傳入。
- 第 5 參數（AI 診斷 `diagnosis`）選填，使用者沒要求就不要接。要接時，用本目錄的 `scripts/diagnose-e2e-failure.sh` 產生診斷檔，**位元組一致地複製**，不要修改。它需要 Anthropic WIF 認證，所需環境變數見 script 開頭註解。
- `job.status` 為 `cancelled` 時會送出 fail。這是刻意的：nightly 被取消就代表沒有測試結果，需要人看。
- 回報 step 失敗會讓整個 job 變紅，這也是刻意的：接線出錯必須看得見。
- ubuntu runner 預設就有 `jq`、`openssl`、`curl`。

**心跳 fail 已經會告警**，一般不需要再推 ingest。只有服務在執行期（非 CI）要回報錯誤時才用 `/api/ingest`。此時 `message` 必須是固定字串，次數、時間、URL 一律放進 `metadata`，否則每次回報都會長出一筆新 issue。

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
