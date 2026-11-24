# 資安發現生命週期（待處理／已解決／已忽略）設計

日期：2026-11-24
前置 spec：`2026-11-18-security-monitoring-design.md`（本文件推翻其非目標「不提供已確認／已解決等操作狀態」，其餘沿用）

## 意圖與動機

現行資安監控每天每服務 insert 一筆快照（`security_scans`），`/security` 只顯示最新一筆的發現，發現沒有身分、沒有狀態：

- 問題沒修就每天重出一次，修好要等下次掃描才消失，無從追蹤「這條我處理過了沒」。
- `changes` 類（新增帳號、新容器…）因基準取 7 天窗最舊快照，會連續約 7 天出現後**自行消失**，與是否處理無關。

目標是讓每一條資安發現成為**以 issue 為單位的持久紀錄**，後台分頁顯示狀態，每日掃描與既有紀錄去重而不產生新紀錄。

## 目標

1. 每條發現有跨日穩定的指紋（fingerprint），以 `(service_id, fingerprint)` 唯一。
2. 三種狀態：**待處理（open）／已解決（resolved）／已忽略（ignored）**，`/security` 以三個分頁分開顯示。
3. 每日掃描：與既有紀錄同指紋者只更新，不新增。
4. 已解決者再被掃到 → **重開同一筆**（回待處理，`reopen_count + 1`）。
5. 已忽略者再被掃到 → 維持忽略，只更新最後看到時間。
6. 掃描**確實檢查過**且沒再看到的待處理紀錄 → 自動標為已解決（由 system）。

## 非目標

- 不發 Discord、不進一般 issue 管線（沿用前置 spec）。
- 不改服務×檢查矩陣的燈號語意（燈號仍來自最新快照 `checks`，不因忽略而轉綠）。
- 不回填歷史：上線後第一次掃描才建立紀錄，既有問題的「首次發現」＝上線後首掃時間。
- 不做發現紀錄的清除（量小，每服務數十筆級）。快照 90 天清除照舊。
- 不新增 acknowledged 狀態。

## 反目標（做了等於失敗）

- 每日掃描讓同一問題出現第二筆紀錄（指紋不穩）。
- 檢查**沒跑成功**（`unknown`、某網域首頁抓不到、log 來源讀取錯誤）卻把紀錄自動標成已解決——等於誤報「修好了」。
- 已忽略的項目反覆跳回待處理。

## 考慮過的做法

| 做法 | 取捨 | 結論 |
|---|---|---|
| ① 寫入時同步更新發現表 | 新表 `security_findings`；`POST /api/security-scan` 存快照後依指紋 reconcile；邏輯是 `src/core/security/` 純函式，頁面讀表即可 | **採用** |
| ② 讀取時從歷史快照推算，只存人工操作 | 不必維護表，但每次讀取掃全部快照；快照 90 天清除後首次發現與復發次數失真 | 排除 |
| ③ Postgres trigger | 邏輯進 SQL，脫離 core 純函式＋測試慣例 | 排除 |

LLM 判讀類（ports／updates／logins）的指紋粒度另有兩案：

| 做法 | 取捨 | 結論 |
|---|---|---|
| A. 以「服務＋類別」為一筆 | 穩定，但無法逐項忽略（忽略 22 埠就連 3306 一起忽略） | 排除（使用者要以 issue 為單位） |
| B. LLM 從**受控鍵規格**挑選並填值，beacon 以 regex 驗證，不合則退回類別級 | 以 issue 為單位；LLM 挑固定格式比自由命名穩 | **採用** |

## 指紋規格

完整指紋＝`<check>:<key>`。key 由產出端在建立 Finding 時填入，**不得取自 title**（title 含易變文字）。

### LLM 判讀類（`scripts/security/lib/judge.ts`）

JSON schema 的 finding 加必填 `key`；prompt 列出下表規格，並把「同類合併成一筆」改為「**同 key 合併成一筆**」（例：12 個待更新套件仍是 `updates:security` 一筆，title 每日更新數量）。key **不含** check 前綴（完整指紋由 beacon 組成 `<check>:<key>`）。

| check | key 格式（regex 驗證） | 完整指紋例 | 說明 |
|---|---|---|---|
| ports | `(tcp\|udp)/<1-65535>` | `ports:tcp/3306` | 每個對外埠一筆 |
| updates | `security\|eol\|reboot\|auto-disabled` | `updates:security` | 安全性更新／高重大漏洞→security；OS 過支援期→eol；需重開機→reboot；自動安全更新未啟用→auto-disabled |
| logins | `password-auth\|root-login\|failed-spike` 或 `unexpected-success:<IPv4/IPv6>` | `logins:root-login` | 非預期成功登入依來源 IP 各一筆 |

**驗證只在 beacon 端**（`src/core/security/` 的純函式，於 payload 解析後套用）；`judge.ts` 只負責要求 LLM 輸出 `key` 並原樣送出。payload 的 `findings[].key` 為**選填**：缺少或不合規格 → key 改為 `_fallback`，紀錄標 `key_fallback = true`（供日後檢討 prompt）。缺 key 不拒收，避免 scanner 與 beacon 部署順序不一致時整次掃描被 422 丟掉。同一次掃描內同指紋的多筆 → 合併為一筆（取最高 severity 那筆的 title／recommendation）。

### 確定性產出類（beacon 端 evaluator）

自然鍵來源見各 evaluator；`\0` 分隔的複合鍵改用 `|` 以利顯示。

| check | 來源 | key |
|---|---|---|
| changes 新增管理員 | `src/core/security/changes.ts:42-50` | `admin:<name>` |
| changes SSH 金鑰 | `changes.ts:51-55` | `sshkey:<user>\|<fingerprint>` |
| changes 新帳號 | `changes.ts:60-62` | `user:<name>` |
| changes 排程 | `changes.ts:63-66` | `cron:<location>\|<hash>` |
| changes 監聽埠 | `changes.ts:67-69` | `listen:<proto>\|<port>`（不含 process 名） |
| changes 常駐服務 | `changes.ts:70` | `unit:<name>` |
| changes 容器 | `changes.ts:74-86` | `container:<name>`、`container-image:<name>`、`container-port:<name>\|<port>` |
| changes 容器清單消失 | `changes.ts:88-91` | `containers-unavailable` |
| exposure 敏感路徑 | `src/core/security/exposure.ts:22` | `path:<domain>\|<path>` |
| exposure 缺標頭 | `exposure.ts:24-30` | `header:<domain>\|<headerKey>`（用 key 不用顯示名） |
| exposure 舊版 TLS | `exposure.ts:27` | `legacy-tls:<domain>` |
| logVolume | `src/core/security/log-volume.ts:76-90` | `<source>` |
| cert 不受信任 | `src/core/security/view.ts:55-60` | `untrusted:<domain>` |
| cert 到期 | `view.ts:65-86` | `expiry:<domain>` |

確定性產出類的 key 原樣取自比對鍵（含 `changes.ts` 的哨兵值如 `?sudoers:<hash>`、`#uid`、`%group`、`(sshd)`），**不套 regex**，只把 `\0` 換成 `|`。

`Finding` 型別（`src/core/security/types.ts:12`）加 `key: string`。

**cert 改為寫入時逐網域推導**：現行 `evaluateCertExpiry`（`view.ts:67-86`）只對最早到期的那張出一筆，若沿用，「certs 中有該 domain」就不能代表它被評估過（B 變成最早到期後，A 會被誤解決）。因此新增寫入端純函式，對**每個** domain 各自判斷不受信任／過期／即將到期，以 `scannedAt` 計算剩餘天數，產出 `untrusted:<domain>`、`expiry:<domain>` 發現進入 reconcile。矩陣的 cert 燈號與摘要維持現行讀取端推導（以 `now`、取最早到期），不改語意；兩者天數可能差不到一天，可接受。讀取端 `buildSecurityView` 不再把 cert 發現與 `scan.findings` 合併成 `todos`（`view.ts:157`），`todos` 與其測試一併移除／改寫。

「掃描停擺」（`view.ts:147-155`）不是發現，維持讀取端推導的橫幅，不建紀錄。

## 資料模型

新表 `security_findings`（migration 走 `supabase migration new` → `db push`）：

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | uuid pk | |
| service_id | uuid fk → services, on delete cascade | |
| fingerprint | text | `<check>:<key>` |
| check | text | |
| status | text check in ('open','resolved','ignored') | |
| severity / title / recommendation | text | 最近一次觀察到的內容 |
| key_fallback | boolean default false | |
| first_seen_at / last_seen_at | timestamptz | 以快照 `scanned_at` 計 |
| status_changed_at | timestamptz | |
| status_changed_by | text | `system` 或登入者 email |
| reopen_count | int default 0 | |
| missed_count | int default 0 | open 狀態下，連續「在涵蓋範圍內卻沒觀察到」的次數；觀察到即歸零 |

- `unique (service_id, fingerprint)`；index `(status, service_id)`。
- RLS 啟用、無 policy（沿用專案 deny-by-default）。
- 狀態型別自訂 `SecurityFindingStatus = 'open' | 'resolved' | 'ignored'`，**不重用** `IssueStatus`／`IssueActor`（避免碰到一般 issue 的 switch 與 Discord 流程）。

## Reconcile 規則（純函式 `reconcileFindings`）

輸入：該服務現有紀錄、本次觀察到的發現（已含 key）、本次的**涵蓋範圍（coverage）**、`scannedAt`。輸出：要 insert／update 的列。

| 現有狀態 | 本次觀察到 | 本次沒觀察到，且在涵蓋範圍內 | 沒觀察到，不在涵蓋範圍 |
|---|---|---|---|
| （無紀錄） | insert open | — | — |
| open | 更新內容、last_seen、missed_count=0 | missed_count+1；達門檻 → resolved（by system） | 不動 |
| resolved | → open、reopen_count+1、更新內容 | 不動 | 不動 |
| ignored | 更新內容、last_seen，狀態不動 | 不動 | 不動 |

**自動解決門檻（遲滯）**：LLM 判讀類（ports／updates／logins，含 `_fallback`）需**連續 2 次**涵蓋範圍內未觀察到才自動解決，避免 LLM 單次漏報造成「解決→重開」震盪灌水 `reopen_count`；確定性產出類（exposure／logVolume／cert）1 次即解決。門檻為 `src/core/security/constants.ts` 常數。

**`changes` 類例外（事件型）**：它代表「相對基準發生的變動」，基準窗滾動後自然不再出現，「沒再看到」不代表修好；且基準窗內會連續數日被重報。因此：
- 從不自動解決，只能人工解決或忽略。
- resolved 狀態下再被觀察到：若距 `last_seen_at` **未超過** `BASELINE_WINDOW_DAYS + 1` 天，視為同一事件的重報，只更新 last_seen；**超過**則視為新事件（例：帳號移除一個月後又被加回）→ 重開、reopen_count+1。
- ignored 照一般規則（維持忽略）。
- 頁面上 open 的 changes 紀錄若 last_seen 已超過基準窗，標註「已不在變動比對窗內」，提示可直接解決。

**涵蓋範圍**：一筆 open 紀錄只有在本次掃描「確實檢查過它」時才可自動解決：

| check | 視為檢查過的條件 |
|---|---|
| ports / updates / logins | 該項 `checks[check].status ∈ {ok, warn, bad}`（`unknown`、`na` 不算） |
| `_fallback` 紀錄 | 同上（類別級） |
| exposure `header:`／`legacy-tls:` | 本次 exposure 事實中有該 domain，且 `exposure` 檢查非 unknown；`legacy-tls:` 另需該 domain 的 `legacyTls !== null`（首頁抓不到時整個 domain 不送，`external.ts:53`，自然不在涵蓋範圍） |
| exposure `path:` | 同上，**且**該 domain 的 `probeErrors === 0`（見下方契約變更；欄位缺少視為未涵蓋） |
| logVolume | 本次有該 source 且其 `error !== true` |
| cert | 本次 `certs` 中有該 domain（寫入端已逐網域評估，見上） |

**敏感路徑探測失敗**：現行 `external.ts:76-87` 單一路徑逾時／連線錯誤時記 `exposed:false` 並累加 `probeErrors`，但 `probeErrors` 不進 payload，beacon 無法分辨「沒暴露」與「沒探到」。改為 `ExposureFact` 加選填 `probeErrors: number`（scanner 原樣送出、`payload.ts` 保留、`docs/api.md` §9 記載）。舊 scanner 不送 → 視為未涵蓋，`path:` 紀錄不會被誤解決。

**時序防護**：insert 快照前先查該服務最新快照的 `scanned_at`（Store port 新增 `getLatestSecurityScanAt(serviceId)`，`memory.ts` 與 `supabase.ts` 兩套都要實作）。若本次 `scannedAt` 早於它（補送舊掃描），快照照常寫入（它仍是歷史，也是基準來源），但**跳過 reconcile**。重送同一 `scannedAt`（insert 回 null → `duplicate:true`）也不 reconcile。

## 寫入路徑

`src/security-scan/handle-security-scan.ts`：快照 insert 成功（非 duplicate）後，讀該服務現有 `security_findings` → `reconcileFindings` → 批次寫回。reconcile 失敗只記 log，不影響 201 回應（快照仍是真實來源，下一次掃描會補齊）。Store port 新增 `listSecurityFindings(serviceId)`、`upsertSecurityFindings(rows)`（既有列帶 `id`＋`expectedStatus`，僅在 DB status 仍相符時條件更新，避免蓋掉 list 之後的人工狀態變更；新列 insert，唯一鍵衝突則略過，皆不回傳衝突者，下次掃描會再 reconcile）、`setSecurityFindingStatus(id, to, expectedFrom, by, now)`（條件更新，`where status = expectedFrom`，避免與掃描競態）。

## 人工操作

Server action（`app/security/actions.ts`，第一行 `await requireUser()`，照 `app/services/actions.ts` 慣例）：

| 分頁 | 可用操作 |
|---|---|
| 待處理 | 標為已解決、忽略 |
| 已解決 | 忽略 |
| 已忽略 | 取消忽略（→ 待處理） |

`status_changed_by` 記登入者 email。條件更新失敗（狀態已被掃描改掉）→ 回傳提示並重新整理。

## 頁面

`/security`（server component）：

```
[掃描停擺橫幅（若有）]
[ 待處理 (7) | 已解決 (23) | 已忽略 (2) ]     ← ?tab=open|resolved|ignored
┌ 服務 · 類別 · 嚴重度 ───────────────────────────┐
│ title                                        │
│ recommendation                               │
│ 首次 11/20 · 最後 11/24 · 復發 1 次 · [解決][忽略] │
└──────────────────────────────────────────────┘
[服務 × 檢查矩陣（不變）]
```

- 取代現行「待辦清單」（`view.todos`）；矩陣與停擺判定照舊讀最新快照。
- 排序：待處理依 severity 再依 last_seen desc；已解決依 status_changed_at desc，最多 100 筆。
- 列表 key 用紀錄 id（現行用 index）。
- 某服務掃描停擺時，其待處理紀錄仍顯示，但標註「掃描停擺，狀態可能過期」。

## 契約與文件

- `docs/api.md` §9：`findings[]` 加選填 `key`（列出三類 key 規格，缺少或不合規格退回類別級）；`exposure[]` 加選填 `probeErrors`。掃描器在本 repo，外部 repo 不受影響。
- `payload.ts` 的 findings 與 exposure 解析需保留新欄位（現行 `parseFindings` 只挑四欄位，`payload.ts:93-111`）。
- 更新前置 spec 的非目標條目、`scripts/CLAUDE.md` 與 `CLAUDE.md` 資安段落。

## 驗收

- `pnpm test`：`reconcileFindings` 涵蓋上表每一格、changes 例外、涵蓋範圍各條件、時序防護、同指紋合併；key regex 驗證與 fallback；各 evaluator 產出的 key。
- `pnpm test:integration`（本地 stack）：store 的 upsert 與條件更新。
- `pnpm typecheck`、`pnpm build`。
- 上線後手動觸發一次 workflow，確認紀錄建立；隔日掃描確認未產生重複。

## 留給實作者

- server action 的表單／按鈕元件寫法、分頁 UI 細節。
- reconcile 批次寫入是一次 upsert 還是逐筆。
- prompt 的確切措辭（須包含 key 規格表與「同 key 合併」）。

## 設計者代為決定的點（使用者授權直接開工，事後可改）

- 已解決分頁只提供「忽略」，不提供「重開」（重開交給掃描）。
- `changes` 類為事件型：不自動解決；已解決後在基準窗＋1 天內重報不重開，超過才重開。
- LLM 判讀類自動解決需連續 2 次未見；確定性類 1 次。
- cert 寫入端改逐網域評估；矩陣燈號維持取最早到期。
- `findings[].key`、`exposure[].probeErrors` 皆為選填，缺少時保守處理（退回類別級／不涵蓋）。
- 不回填歷史、不清除發現紀錄。
- 矩陣燈號不受忽略影響。
