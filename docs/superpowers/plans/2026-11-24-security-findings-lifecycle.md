# 資安發現生命週期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 資安發現成為以指紋去重的持久紀錄（待處理／已解決／已忽略），每日掃描 reconcile，`/security` 分頁顯示並可人工操作。

**Architecture:** 新表 `security_findings`；`POST /api/security-scan` 存快照後以純函式 `reconcileFindings` 算出寫入列並 upsert。指紋＝`<check>:<key>`，key 由各 evaluator 或（LLM 類）beacon 端驗證後產生。頁面讀新表分三分頁，server action 做條件更新。

**Tech Stack:** Next.js App Router、Supabase Postgres、TypeScript、Vitest、pnpm。

**Spec:** `docs/superpowers/specs/2026-11-24-security-findings-lifecycle-design.md`（每個 task 開工前先讀完）

## Global Constraints

- `src/core/**` 純函式：禁 I/O、禁 `Date.now()`／`new Date()` 無參數；時間一律由參數注入。
- `src/core/security/**` 與 `scripts/security/**` 只用**相對路徑加 `.ts` 副檔名** import（Node type stripping 直接執行）。
- 新表 RLS 啟用、**無 policy**。勿為消 advisors INFO 加 policy。
- Migration：`supabase migration new <name>` → 編輯 → `supabase db push` → `supabase db advisors --type security` → `pnpm db:types`。**禁用 MCP `apply_migration`**。
- `pnpm test:integration` **只跑本地 stack**（`supabase start` → `supabase db reset`），絕不指向線上。
- 勿跑 `pnpm dev`。
- commit 用明確路徑 `git add`，禁 `git add -A`；**不要 add `CLAUDE.md`、`scripts/CLAUDE.md`**（工作樹上有使用者未提交的改動）。commit 訊息結尾：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- 使用者可見文字一律繁體中文。狀態顯示名：open＝「待處理」、resolved＝「已解決」、ignored＝「已忽略」。
- 常數（加入 `src/core/security/constants.ts`）：`AUTO_RESOLVE_MISSES_JUDGED = 2`、`AUTO_RESOLVE_MISSES_COMPUTED = 1`、`CHANGES_REOPEN_GAP_DAYS = BASELINE_WINDOW_DAYS + 1`、`RESOLVED_LIST_LIMIT = 100`、`FALLBACK_KEY = '_fallback'`。

## Review Focus

1. 同一次掃描 LLM 回兩筆同 key（或兩筆皆 fallback）→ 只產一筆紀錄，取最高 severity 的內容。（Task 3 測試 `merges duplicate fingerprints`）
2. 某 exposure domain 這次整個缺席（首頁抓不到）→ 該 domain 所有 open 紀錄不動。（Task 3 測試 `absent domain is not covered`）
3. hosted 服務 `ports` 為 `na` → 不得自動解決任何 ports 紀錄。（Task 3 測試 `na check is not covered`）
4. 使用者在頁面按「解決」的同時掃描已把它改掉 → 條件更新失敗，回提示不覆寫。（Task 4 整合測試 `conditional status update fails on mismatch`、Task 7 action 回傳 `stale`）
5. 舊快照（jsonb findings 無 key）被讀出 → 不崩潰，key 補 `_fallback`。（Task 1 mapping 測試）

---

### Task 1: Finding key 型別、LLM key 驗證、payload 解析

**Files:**
- Modify: `src/core/security/types.ts:12`（Finding）、`:17`（ExposureFact）
- Create: `src/core/security/finding-key.ts`
- Modify: `src/core/security/payload.ts:93-114`（parseFindings）、`:145-204`（parseExposure）
- Modify: `src/store/mapping.ts:207-220`（rowToSecurityScan）
- Modify: `src/core/security/constants.ts`（加 Global Constraints 的常數）
- Test: `tests/core/security/finding-key.test.ts`（新）、`tests/core/security/payload.test.ts`、`tests/store/mapping.test.ts`

**Interfaces:**
- Produces:
  - `Finding` 加 `key: string; keyFallback?: true`
  - `ExposureFact` 加 `probeErrors?: number`
  - `normalizeJudgedKey(check: JudgedCheckKey, raw: unknown): { key: string; keyFallback: boolean }`（`finding-key.ts`）
  - `fingerprintOf(f: Pick<Finding, 'check' | 'key'>): string` → `` `${check}:${key}` ``（`finding-key.ts`）

- [ ] **Step 1: 寫失敗測試** `finding-key.test.ts`：
  - `normalizeJudgedKey('ports','tcp/3306')` → `{key:'tcp/3306', keyFallback:false}`；`'udp/53'` 通過；`'tcp/0'`、`'tcp/65536'`、`'port:tcp/22'`、`'TCP/22'` → `{key:'_fallback', keyFallback:true}`
  - updates：`security|eol|reboot|auto-disabled` 通過；`'kernel'` fallback
  - logins：`password-auth|root-login|failed-spike` 通過；`'unexpected-success:203.0.113.5'`、`'unexpected-success:2001:db8::1'` 通過；`'unexpected-success:'`、`'unexpected-success:evil host'` fallback
  - `undefined`、`42`、`''` → fallback
  - `fingerprintOf({check:'ports', key:'tcp/22'})` === `'ports:tcp/22'`
- [ ] **Step 2: 跑** `pnpm vitest run tests/core/security/finding-key.test.ts`，預期 FAIL（模組不存在）
- [ ] **Step 3: 實作 `finding-key.ts`**（每個 check 一條 regex；IP 部分用 `[0-9A-Fa-f:.]+`；port 數值另檢 1–65535）
- [ ] **Step 4: payload 測試**（`payload.test.ts` 新增）：
  - findings 帶合法 key → 解析結果保留 key、無 keyFallback
  - findings 缺 key → **不回 422**，`key:'_fallback', keyFallback:true`
  - exposure 帶 `probeErrors: 2` → 保留；缺 → 解析結果無此欄；`probeErrors: -1` 或非整數 → 422
- [ ] **Step 5: 改 `parseFindings`、`parseExposure`** 使 Step 4 通過（parseFindings 呼叫 `normalizeJudgedKey`）
- [ ] **Step 6: mapping 測試**：`rowToSecurityScan` 遇 findings 元素無 `key` → 補 `key:'_fallback', keyFallback:true`；實作之
- [ ] **Step 7: 跑** `pnpm vitest run tests/core/security tests/store/mapping.test.ts` 全 PASS；`pnpm typecheck` 會因 evaluator 未帶 key 報錯——此時允許，Task 2 修正（若想保持綠燈，可在本 task 暫給 evaluator 的 Finding 補 `key: FALLBACK_KEY`，Task 2 再換正式 key）。**本 task 採後者，typecheck 必須通過。**
- [ ] **Step 8: Commit**
```bash
git add src/core/security/types.ts src/core/security/finding-key.ts src/core/security/payload.ts src/core/security/constants.ts src/store/mapping.ts src/core/security/changes.ts src/core/security/exposure.ts src/core/security/log-volume.ts src/core/security/view.ts tests/core/security/finding-key.test.ts tests/core/security/payload.test.ts tests/store/mapping.test.ts
git commit -m "feat(security): Finding 加穩定 key，LLM 類 key 由 beacon 驗證並退回 fallback"
```
（只 add 實際改動的檔）

### Task 2: 確定性 evaluator 產出正式 key ＋ 逐網域 cert 發現

**Files:**
- Modify: `src/core/security/changes.ts:33-97`、`exposure.ts:13-30`、`log-volume.ts:85-90`
- Create: `src/core/security/cert-findings.ts`
- Test: `tests/core/security/{changes,exposure,log-volume}.test.ts`、`tests/core/security/cert-findings.test.ts`（新）

**Interfaces:**
- Consumes: Task 1 的 `Finding.key`
- Produces: `evaluateCertFindings(certs: CertFact[], scannedAt: Date): Finding[]`（`cert-findings.ts`）

key 規格照 spec「確定性產出類」表，`\0` 換 `|`，哨兵值原樣保留：

| 來源 | key |
|---|---|
| admins | `admin:<adminKey>` |
| sshKeys | `sshkey:<user>\|<fingerprint>` |
| users | `user:<name>` |
| scheduled | `cron:<location>\|<hash>` |
| listeners | `listen:<proto>\|<port>` |
| services | `unit:<name>` |
| 容器 | `container:<name>`、`container-image:<name>`、`container-port:<name>\|<port>` |
| 容器清單消失 | `containers-unavailable` |
| exposure | `path:<domain>\|<path>`、`header:<domain>\|<headerKey>`（`REQUIRED`/`OPTIONAL` 元組第一元素）、`legacy-tls:<domain>` |
| logVolume | `<src.source>` |
| cert | `untrusted:<domain>`、`expiry:<domain>` |

- [ ] **Step 1: 寫失敗測試**：每個 evaluator 既有測試案例加 key 斷言（每種來源至少一例，含一個 `?sudoers:` 哨兵 admin 與一個 `(sshd)` sshKey）；`cert-findings.test.ts`：
  - 兩個 domain A（剩 20 天）、B（剩 10 天）→ 兩筆：`expiry:A` medium、`expiry:B` high（`CERT_BAD_DAYS=14`、`CERT_WARN_DAYS=30`）
  - 剩 40 天 → 無發現；已過期 → high
  - `trusted:false` → `untrusted:<domain>` high（與 expiry 可並存）
  - 天數以參數 `scannedAt` 計
  - `certs=[]` → `[]`
- [ ] **Step 2: 跑** 上述測試檔，預期 FAIL
- [ ] **Step 3: 實作**：evaluator 內部 `add` 多收 key；`evaluateCertFindings` 的 title／recommendation／severity 判準沿用 `view.ts:49-86` 的現行文字與門檻（逐網域套用），不改 `view.ts` 的 `evaluateCert` 本身
- [ ] **Step 4: 跑** `pnpm vitest run tests/core/security` 全 PASS、`pnpm typecheck` 通過
- [ ] **Step 5: Commit**（明確路徑）`feat(security): evaluator 產出穩定 key，cert 改逐網域發現`

### Task 3: `reconcileFindings` 純函式與涵蓋範圍

**Files:**
- Create: `src/core/security/findings.ts`
- Test: `tests/core/security/findings.test.ts`

**Interfaces:**
- Consumes: Task 1 `fingerprintOf`、`FALLBACK_KEY`；常數 `AUTO_RESOLVE_MISSES_*`、`CHANGES_REOPEN_GAP_DAYS`
- Produces（皆在 `findings.ts`）：
```ts
export type SecurityFindingStatus = 'open' | 'resolved' | 'ignored'
export interface SecurityFindingRecord {
  id: string; serviceId: string; fingerprint: string; check: CheckKey
  status: SecurityFindingStatus; severity: FindingSeverity; title: string; recommendation: string
  keyFallback: boolean; firstSeenAt: string; lastSeenAt: string
  statusChangedAt: string; statusChangedBy: string | null
  reopenCount: number; missedCount: number
}
export type SecurityFindingWrite = Omit<SecurityFindingRecord, 'id'>   // 以 (serviceId, fingerprint) upsert
export interface CoverageInput {
  checks: Record<StoredCheckKey, CheckResult>
  exposure: ExposureFact[]; logVolume: LogSourceVolume[]; certs: CertFact[]
}
export function isCovered(record: Pick<SecurityFindingRecord, 'check' | 'fingerprint'>, cov: CoverageInput): boolean
export function reconcileFindings(input: {
  serviceId: string; existing: SecurityFindingRecord[]; observed: Finding[]
  coverage: CoverageInput; scannedAt: string
}): SecurityFindingWrite[]          // 只回傳有變動的列
export const MANUAL_TRANSITIONS: Record<SecurityFindingStatus, readonly SecurityFindingStatus[]>
  // open: ['resolved','ignored'], resolved: ['ignored'], ignored: ['open']
```
規則照 spec「Reconcile 規則」表、遲滯、changes 例外、涵蓋範圍表。system 自動轉換時 `statusChangedBy = 'system'`、`statusChangedAt = scannedAt`。

- [ ] **Step 1: 寫失敗測試**（`scannedAt = '2026-11-24T22:07:00Z'`，每格一個 test）：
  - `inserts new observed as open`：`firstSeenAt=lastSeenAt=scannedAt`、`reopenCount=0`、`missedCount=0`、`statusChangedBy='system'`
  - `open observed updates content and resets missedCount`（existing missedCount=1 → 0，title 換新）
  - `judged open needs 2 covered misses`：ports `status:'ok'`、第一次 → missedCount=1 仍 open；existing missedCount=1 → resolved
  - `computed open resolves after 1 covered miss`（exposure header）
  - `resolved observed reopens`：status open、reopenCount+1、missedCount=0
  - `ignored observed stays ignored`（lastSeenAt 更新，status 不變）
  - `ignored/resolved not observed unchanged`（不出現在輸出）
  - `changes never auto-resolves`：changes open、未觀察、`checks.changes.status='ok'` → 不在輸出
  - `changes resolved re-reported within gap does not reopen`：lastSeenAt = scannedAt−3 天 → 只更新 lastSeenAt
  - `changes resolved re-reported after gap reopens`：lastSeenAt = scannedAt−9 天 → open、reopenCount+1
  - `na check is not covered`、`unknown check is not covered`（ports `na`/`unknown` → 不動，missedCount 也不加）
  - `absent domain is not covered`（`header:a.com|hsts`，exposure 無 a.com）
  - `path needs probeErrors === 0`：a.com `probeErrors:1` 或欄位缺 → 不涵蓋；`0` → 涵蓋
  - `legacy-tls needs non-null`
  - `logVolume source with error is not covered`
  - `cert domain present is covered`
  - `fallback record uses check-level coverage`（`ports:_fallback`）
  - `merges duplicate fingerprints`：observed 兩筆 `ports:tcp/22` medium 與 high → 一筆 high 的內容
  - `keyFallback propagates`
- [ ] **Step 2: 跑** `pnpm vitest run tests/core/security/findings.test.ts`，預期 FAIL
- [ ] **Step 3: 實作 `findings.ts`**；`isCovered` 依 fingerprint 前綴（`<check>:` 之後的 key，再以第一個 `:` 前綴與第一個 `|` 切出 domain／source）判斷
- [ ] **Step 4: 跑** 該測試 PASS、`pnpm typecheck` 通過
- [ ] **Step 5: Commit** `feat(security): reconcileFindings 純函式（指紋去重、遲滯、涵蓋範圍）`

### Task 4: `security_findings` 表與 Store port

**Files:**
- Create: `supabase/migrations/<timestamp>_security_findings.sql`（以 `supabase migration new security_findings` 產生）
- Regenerate: `src/db/database.types.ts`（`pnpm db:types`）
- Modify: `src/store/contracts.ts:239-246`、`src/store/memory.ts`（:543 一帶後追加）、`src/store/supabase.ts`（:586 後追加）、`src/store/mapping.ts`
- Modify: `tests/integration/helpers.ts:27`（清表清單於 `'security_scans'` 前加 `'security_findings'`）
- Test: `tests/store/security-findings-memory.test.ts`（新）、`tests/integration/security-findings-store.test.ts`（新）

**Interfaces:**
- Consumes: Task 3 型別
- Produces（Store interface）：
```ts
getLatestSecurityScanAt(serviceId: string): Promise<string | null>
listSecurityFindings(serviceId: string): Promise<SecurityFindingRecord[]>
upsertSecurityFindings(rows: SecurityFindingWrite[]): Promise<void>      // onConflict (service_id, fingerprint)
setSecurityFindingStatus(id: string, to: SecurityFindingStatus, expectedFrom: SecurityFindingStatus,
  by: string, nowIso: string): Promise<boolean>   // where status = expectedFrom；成功 true；同時 missed_count=0
```
- `mapping.ts`：`rowToSecurityFinding(row): SecurityFindingRecord`、`securityFindingWriteToRow(w)`
- InMemoryStore 測試輔助：`listAllSecurityFindings(): SecurityFindingRecord[]`

Schema 照 spec「資料模型」表：`check` 不加 DB check 約束（值域在 TS），`status text not null check (status in ('open','resolved','ignored'))`，`unique (service_id, fingerprint)`，index `security_findings_status_service_idx (status, service_id)`，`alter table public.security_findings enable row level security;`，無 policy。

- [ ] **Step 1: 寫 migration**，`supabase db reset`（本地）確認可套用
- [ ] **Step 2: 寫失敗測試**：memory 與 integration 各含 `upsert inserts then updates same fingerprint`（同 serviceId+fingerprint 兩次 → 一列）、`conditional status update fails on mismatch`（expectedFrom 不符 → false、資料不變）、`conditional status update succeeds and resets missedCount`、`getLatestSecurityScanAt returns max scanned_at or null`、`deleting service cascades findings`（integration）
- [ ] **Step 3: 跑** `pnpm vitest run tests/store/security-findings-memory.test.ts` 與 `pnpm test:integration -- security-findings-store`，預期 FAIL
- [ ] **Step 4: 實作** memory 與 supabase 兩套
- [ ] **Step 5: 跑** 兩者 PASS；`pnpm test:integration` 全部 PASS（本地 stack）
- [ ] **Step 6: 上線**：`supabase db push` → `supabase db advisors --type security`（預期只有 rls_enabled_no_policy INFO）→ `pnpm db:types` → `pnpm typecheck` 通過
- [ ] **Step 7: Commit** migration、types、store、mapping、helpers、測試 `feat(security): security_findings 表與 store port`

### Task 5: handler 接上時序防護與 reconcile

**Files:**
- Modify: `src/security-scan/handle-security-scan.ts:51-77`
- Test: `tests/security-scan/handle-security-scan.test.ts`

**Interfaces:**
- Consumes: Task 2 `evaluateCertFindings`、Task 3 `reconcileFindings`、Task 4 store 方法

流程：parse 後、insert 前呼叫 `getLatestSecurityScanAt`；insert 回 null → 200 duplicate（不 reconcile）；若 `latest !== null && payload.scannedAt < latest` → 跳過 reconcile；否則 `observed = [...payload.findings, ...logVolume.findings, ...exposure.findings, ...changes.findings, ...evaluateCertFindings(payload.certs, new Date(payload.scannedAt))]`（cert 發現**不寫進**快照 findings），`coverage = { checks, exposure: payload.exposure, logVolume: logVolume.logVolume, certs: payload.certs }`，`listSecurityFindings` → `reconcileFindings` → `upsertSecurityFindings`。reconcile 段包 try/catch，失敗 `console.error('[security-scan] reconcile failed', err)`，仍回 201。

- [ ] **Step 1: 寫失敗測試**：
  - `first scan creates open findings`（含一筆 cert expiry）
  - `second scan same findings creates no duplicates`（`store.listAllSecurityFindings()` 筆數不變、lastSeenAt 為第二次 scannedAt）
  - `duplicate scannedAt does not reconcile`
  - `older scannedAt than latest skips reconcile but stores snapshot`
  - `reconcile failure still returns 201`（以 spy 讓 `upsertSecurityFindings` reject）
  - `cert findings not stored in snapshot`
- [ ] **Step 2: 跑** `pnpm vitest run tests/security-scan/handle-security-scan.test.ts`，預期 FAIL
- [ ] **Step 3: 實作**
- [ ] **Step 4: 跑** PASS；`pnpm test` 全 PASS；`pnpm typecheck`
- [ ] **Step 5: Commit** `feat(security): 掃描寫入時 reconcile 資安發現紀錄`

### Task 6: scanner 輸出 key 與 probeErrors、契約文件

**Files:**
- Modify: `scripts/security/lib/judge.ts:13-34`（prompt）、`:36-62`（schema）、`:159-173`（驗證）
- Modify: `scripts/security/scan.mts:85-87`
- Modify: `docs/api.md` §9（約 :468-573）
- Modify: `docs/superpowers/specs/2026-11-18-security-monitoring-design.md:38`（非目標條目加註「已由 2026-11-24 生命週期 spec 推翻」）
- Test: `tests/scripts/security-scan.test.ts`、`tests/scripts/security-external.test.ts`、judge 相關既有測試

**Interfaces:** Consumes Task 1 payload 欄位（`findings[].key`、`exposure[].probeErrors`）。

- [ ] **Step 1: 寫失敗測試**：judge 驗證段保留模型回傳的 `key` 字串原樣（不驗格式）、缺 key 時不帶該欄；scan.mts 組出的 exposure 每筆帶 `probeErrors`（用既有 fixture，一個 domain 有一條路徑逾時 → `probeErrors:1`）
- [ ] **Step 2: 跑** 相關測試，預期 FAIL
- [ ] **Step 3: 實作**：schema finding `required` 加 `'key'`、properties 加 `key: {type:'string'}`；prompt 加 key 規格表（spec「LLM 判讀類」表，key 不含 check 前綴），「同類合併成一筆」改「同 key 合併成一筆」；scan.mts `exposure.push({ ...fact, probeErrors: failed, legacyTls })`，移除 external.ts:42「不進 payload」過時註解
- [ ] **Step 4: 文件**：api.md §9 欄位表加 `findings[].key`（選填、規格表、缺或不合 → 類別級 fallback）與 `exposure[].probeErrors`（選填，缺則敏感路徑不會被自動判為已解決）
- [ ] **Step 5: 跑** `pnpm test` 全 PASS、`pnpm typecheck`
- [ ] **Step 6: Commit** `feat(security): scanner 輸出 finding key 與 probeErrors，更新契約`

### Task 7: `/security` 分頁與人工操作

**Files:**
- Modify: `src/core/security/view.ts`（移除 `todos` 組裝 :147-168 中的 findings／cert 合併；保留停擺判定——改為 `SecurityView.staleServices: string[]`）、`tests/core/security/view.test.ts`
- Modify: `src/web/security-queries.ts`
- Create: `app/security/actions.ts`、`app/security/finding-actions.tsx`（client，按鈕）
- Modify: `app/security/page.tsx`、`app/globals.css`（沿用 security-todo 樣式命名可）

**Interfaces:**
- Consumes: Task 3 `SecurityFindingStatus`、`MANUAL_TRANSITIONS`；Task 4 `setSecurityFindingStatus`、`rowToSecurityFinding`
- Produces:
```ts
// src/web/security-queries.ts
export interface FindingListItem extends SecurityFindingRecord { serviceName: string }
export function getSecurityFindings(client: SupabaseClient<Database>, tab: SecurityFindingStatus):
  Promise<{ items: FindingListItem[]; counts: Record<SecurityFindingStatus, number> }>
// app/security/actions.ts
export type FindingActionState = { kind: 'idle' } | { kind: 'ok' } | { kind: 'stale' } | { kind: 'invalid' }
export async function setFindingStatusAction(_prev: FindingActionState, form: FormData): Promise<FindingActionState>
  // form: id, from, to；第一行 await requireUser()；isUuid(id)、MANUAL_TRANSITIONS[from].includes(to) 否則 invalid；
  // by = user.email；false → stale；成功 revalidatePath('/security')
```
- 排序：open 依 severity（high>medium>low）再 lastSeenAt desc；resolved 依 statusChangedAt desc 取 `RESOLVED_LIST_LIMIT`；ignored 依 statusChangedAt desc。
- 頁面：`searchParams.tab ∈ open|resolved|ignored`（預設 open，非法值當 open）；分頁標籤含筆數；每列：服務、類別（`CHECK_LABEL`）、嚴重度、title、recommendation、首次／最後（`formatDateTime`）、復發 N 次（>0 才顯示）、`keyFallback` 顯示小標「未分類」、按鈕依 `MANUAL_TRANSITIONS[status]`（resolved→「標為已解決」、ignored→「忽略」、open→「取消忽略」）；該服務在 `staleServices` 中 → 標「掃描停擺，狀態可能過期」；changes 紀錄 lastSeenAt 早於 now − `BASELINE_WINDOW_DAYS` 天 → 標「已不在變動比對窗內」。空狀態文字：「沒有待處理的資安發現」／「尚無已解決紀錄」／「沒有已忽略的項目」。矩陣保留不變；列表 React key 用 `id`。

- [ ] **Step 1: 改 view.ts 與 `view.test.ts`**（移除 todos 斷言、加 `staleServices` 斷言），跑 `pnpm vitest run tests/core/security/view.test.ts` PASS
- [ ] **Step 2: 實作 queries、actions、client 元件、page**
- [ ] **Step 3: 驗證** `pnpm typecheck`、`pnpm build` 通過（純 UI 部分依專案慣例不另加測試）
- [ ] **Step 4: Commit** `feat(security): /security 待處理／已解決／已忽略分頁與人工操作`

### 收尾

- [ ] `pnpm test`、`pnpm typecheck`、`pnpm build` 全綠；本地 `pnpm test:integration` 全綠
- [ ] 不 push；回報使用者：上線後需手動觸發 `security-scan` workflow 一次驗收、隔日確認無重複；`CLAUDE.md`／`scripts/CLAUDE.md` 的資安段落未更新（工作樹有使用者未提交改動），請使用者決定
