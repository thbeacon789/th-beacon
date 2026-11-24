# 映像檔相依套件漏洞掃描（deps）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 為 VM 目標新增 `deps` 檢查項：以 osv-scanner 掃描每個執行中容器的映像檔（依 digest），確定性判燈後隨快照送到 beacon，於 `/security` 顯示。

**Architecture:** VM 收集腳本新增 `images` 區段回報容器→映像檔 digest；runner（`scan.mts`）依 digest 去重後逐一 `docker pull`→`osv-scanner scan image`→`docker rmi`，由純函式解析與判燈；payload 新增 `checks.deps` 與 `deps` 明細，beacon 驗證後存入 `security_scans.deps`；讀取端把 `deps` 納入矩陣並對舊快照補 `na`。

**Tech Stack:** TypeScript（Node 直接執行 `.mts`、Vitest）、Bash（collect-vm.sh）、Next.js App Router、Supabase Postgres、GitHub Actions、osv-scanner v2.7.1。

**Spec:** `docs/superpowers/specs/2026-11-24-image-deps-scan-design.md`（實作者必讀 §5 全部）

## Global Constraints

- `src/core/security/**` 為純函式：禁 I/O、禁 `Date.now`；只用相對路徑加 `.ts` 副檔名 import。
- VM／osv 輸出皆為不可信輸入：不拿來組 shell 指令字串、不 eval、不當 RegExp；spawn 一律用參數陣列。
- 外部執行檔：osv-scanner **v2.7.1**，`https://github.com/google/osv-scanner/releases/download/v2.7.1/osv-scanner_linux_amd64`，SHA-256 `fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8`。
- 掃描指令固定：`osv-scanner scan image <ref> --x-plugins artifact --x-plugins javascript/packagejson --format json`；exit code ∈ {0,1} 且 stdout 可解析才算成功。
- 嚴重度換算：GHSA `database_specific.severity` 優先（LOW/MODERATE/HIGH/CRITICAL）；否則 group `max_severity` CVSS：≥9.0 critical、≥7.0 high、≥4.0 moderate、>0 low；否則 `unscored`。計數以 group 為單位，以 `(ecosystem, name, version, 排序後 ids 串接)` 去重。
- 燈號（§5.3）：critical→`bad`；high→`warn`；有映像檔失敗→`unknown`；其餘→`ok`；非 vm 或無 Docker／無容器→`na`；images 區段失敗→`unknown`。全部照算，不過濾無修正版或 Debian `unimportant`。
- vm payload **必帶** `checks.deps` 與 `deps`；hosted payload **不得帶**，beacon 寫入時補 `{status:'na',summary:''}`。
- 每映像檔 `packages` 最多 20 筆；單一映像檔 pull＋掃描上限 5 分鐘；workflow scan job `timeout-minutes: 45`。
- workflow 不得加 `pull_request`／`push` 觸發；第三方 action 釘 commit SHA。
- Schema：`supabase migration new` → 編輯 → `supabase db push` → `supabase db advisors --type security` → `pnpm db:types`。禁 MCP `apply_migration`。`pnpm test:integration` 只能對本地 stack。
- 勿跑 `pnpm dev`；commit 用明確路徑 `git add`。

## Review Focus

1. **VM 上有容器沒有 RepoDigests（本機 build／containerd image store）** → 該映像檔 `error: '無 registry digest'`，其餘照掃，燈號至少 `unknown`；不可整個 deps 失敗或被當成 ok。（Task 2、Task 3 測試）
2. **osv-scanner 輸出結構不符（例如 `results` 不是陣列、package 缺 name）** → `parseOsvImageScan` throw，runner 記為該映像檔 `error`，不可回傳全 0。（Task 1 測試）
3. **同一 digest 被多個容器使用、或 RepoDigests 有多筆不同 repository** → 只掃一次，`containers` 列出全部容器名；挑與 `Config.Image` 同 repository 的那筆。（Task 2 測試）
4. **舊快照（無 `checks.deps`、`deps` 欄為 null）** → `/security` 不崩潰，deps 格顯示「不適用」。（Task 5 測試）
5. **osv 輸出很大（後端映像檔上百個有漏洞套件）** → payload 每映像檔只帶前 20 筆、整體仍過 512 KB 上限與 payload 驗證。（Task 1、Task 4 測試）

---

### Task 1: osv-scanner 輸出解析（純函式）

**Files:**
- Create: `src/core/security/collect/osv.ts`
- Test: `tests/core/security/collect/osv.test.ts`
- Fixtures（已建立，勿改）：`tests/core/security/collect/fixtures/osv-caddy.json`、`osv-python.json`、`osv-empty.json`（由真實 osv-scanner v2.7.1 輸出精簡而來）

**Interfaces:**
- Produces（在 `src/core/security/types.ts` 新增並由本檔使用）：
  ```ts
  export type DepSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'unscored'
  export interface DepCounts { critical: number; high: number; moderate: number; low: number; unscored: number }
  export interface DepPackage { name: string; version: string; ecosystem: string; severity: DepSeverity; ids: string[] }
  export interface ImageScanSummary { counts: DepCounts; packages: DepPackage[] }
  ```
- Produces（`osv.ts`）：`export function parseOsvImageScan(json: unknown): ImageScanSummary`；`export const MAX_DEP_PACKAGES = 20`；`export const MAX_DEP_IDS = 5`。

- [ ] **Step 1: 寫失敗測試**

  `tests/core/security/collect/osv.test.ts`，用 `readFileSync` 讀 fixture：
  - `osv-caddy.json` → `counts` 等於 `{ critical: 1, high: 5, moderate: 5, low: 0, unscored: 3 }`；`packages` 共 8 筆，第一筆 `{ name: 'zlib', ecosystem: 'Alpine:v3.24', severity: 'critical' }`（toMatchObject）；`github.com/klauspost/compress` 的 severity 為 `'unscored'`。
  - `osv-python.json` → `counts` 等於 `{ critical: 0, high: 5, moderate: 12, low: 2, unscored: 0 }`；`packages` 共 5 筆（pip 出現在 3 個路徑只算一筆）；`pip@24.0` severity `'moderate'`、`wheel@0.45.1` severity `'high'`、`util-linux` severity `'high'`。
  - `osv-empty.json` → counts 全 0、packages `[]`。
  - 排序：packages 依 critical>high>moderate>low>unscored，同級依 name 升冪。
  - 截斷：以程式產生 25 個各有一個 HIGH group 的 package 的合成輸入 → `packages.length === 20`、`counts.high === 25`。
  - `ids`：每筆最多 5 個、去重；取各 group `ids` 的第一個。
  - 結構不符 throw：`null`、`{}`、`{ results: {} }`、`{ results: [{ packages: [{ package: {} }] }] }`（缺 name）皆 `toThrow()`。
  - CVSS 邊界：合成 group `max_severity` 為 `'9.0'`→critical、`'7.0'`→high、`'4.0'`→moderate、`'0.1'`→low、`''`→unscored、`'0'`→unscored。

- [ ] **Step 2: 跑測試確認失敗**

  Run: `pnpm vitest run tests/core/security/collect/osv.test.ts`
  Expected: FAIL（module not found）

- [ ] **Step 3: 實作 `parseOsvImageScan`**

  每個 package 的每個 group：嚴重度取「組內（`vulnerabilities` 中 id 在 `group.ids` 者）GHSA 標籤的最高者」，無則依 group `max_severity` 換算（Global Constraints）。以 `(ecosystem|name|version|ids 排序串接)` 去重後計數；packages 以 `(ecosystem|name|version)` 合併（severity 取最差、ids 聯集截 5）。`vulnerabilities`／`groups` 缺漏視為空陣列；`results` 非陣列、package 缺字串 `name`／`version`／`ecosystem` 則 throw。

- [ ] **Step 4: 跑測試確認通過**

  Run: `pnpm vitest run tests/core/security/collect/osv.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/security/collect/osv.ts src/core/security/types.ts tests/core/security/collect/osv.test.ts tests/core/security/collect/fixtures/osv-caddy.json tests/core/security/collect/fixtures/osv-python.json tests/core/security/collect/fixtures/osv-empty.json
  git commit -m "feat(security): 解析 osv-scanner 映像檔掃描輸出"
  ```

### Task 2: VM `images` 區段（收集腳本＋解析＋掃描目標挑選）

**Files:**
- Modify: `scripts/security/collect-vm.sh`（新增 `s_images`，在 `section containers s_containers` 之後加 `section images s_images`）
- Modify: `src/core/security/collect/vm-dump.ts`（`VmFacts` 加 `images`；新增解析）
- Create: `src/core/security/collect/images.ts`
- Test: `tests/core/security/collect/vm-dump.test.ts`、`tests/core/security/collect/images.test.ts`、`tests/scripts/security-collect-vm.test.ts`

**Interfaces:**
- Produces（`types.ts`）：`export interface ImageEntry { container: string; configImage: string; imageId: string; repoDigests: string[] }`
- Produces（`vm-dump.ts`）：`VmFacts.images: { entries: ImageEntry[] | undefined; failed: boolean }`（NONE→`entries: undefined, failed: false`；ERROR→`failed: true`）。`images` **不**加入 `REQUIRED_SECTIONS`（缺區段視同 `failed: true`，不讓整次掃描失敗）。
- Produces（`images.ts`）：
  ```ts
  export interface ScanTarget { image: string; digest: string | null; ref: string | null; containers: string[] }
  export function planImageScans(entries: ImageEntry[]): ScanTarget[]
  ```
  `image` 為不含 tag／digest 的 repository；`ref` 為 `<repository>@sha256:<hex>`，無可用 digest 時 `ref` 與 `digest` 為 `null`。

- [ ] **Step 1: 寫失敗測試**
  - `images.test.ts`：
    - 兩個容器 `api`、`worker` 同 `imageId`、`repoDigests: ['asia-east1-docker.pkg.dev/altinvest/backend/app@sha256:aaa…(64 hex)']` → 一個 target，`containers: ['api','worker']`、`image: 'asia-east1-docker.pkg.dev/altinvest/backend/app'`、`ref` 為該 digest ref。
    - `configImage: 'caddy:2-alpine'`、`repoDigests: ['caddy@sha256:…']` → `image: 'caddy'`、ref `caddy@sha256:…`（Docker Hub 短名照用）。
    - `repoDigests` 有兩筆不同 repository → 取與 `configImage` 去 tag 後相同 repository 那筆；都不同則取第一筆。
    - `repoDigests: []` → `digest: null, ref: null`。
    - 不符 `^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[a-f0-9]{64}$` 的 digest 字串一律忽略（防不可信輸入）。
    - 結果依 `image` 升冪排序。
  - `vm-dump.test.ts`：`images` 區段內容 `api\tasia-east1-docker.pkg.dev/altinvest/backend/app:abc\tsha256:111…\tasia-east1-docker.pkg.dev/altinvest/backend/app@sha256:222…` → 一筆 entry；第 4 欄為空（行尾 TAB 被吃）→ `repoDigests: []`；`NONE` → `entries: undefined, failed: false`；`ERROR` → `failed: true`；dump 缺 `images` 區段 → `failed: true` 且 `missingSections` **不含** `images`；欄位數不符的行略過。
  - `security-collect-vm.test.ts`：沿用該檔的 `fake(...)` 假 docker 模式，假 `docker ps -q` 與 `docker inspect` 輸出，斷言 `images` 區段輸出格式；docker 不存在 → `NONE`；`docker ps` 失敗 → `ERROR`；欄位含非法字元的行不輸出原文。

- [ ] **Step 2: 跑測試確認失敗**

  Run: `pnpm vitest run tests/core/security/collect/images.test.ts tests/core/security/collect/vm-dump.test.ts tests/scripts/security-collect-vm.test.ts`
  Expected: FAIL

- [ ] **Step 3: 實作**
  - `s_images`：比照 `s_containers` 的慣例（`command -v docker` → NONE；所有 docker 呼叫 `timeout 20`；失敗 → ERROR；欄位以白名單 regex 驗證，不符則略過該行）。取得執行中容器 ID（`docker ps -q --no-trunc`），以 `docker inspect --type container -f '{{.Name}}{{"\t"}}{{.Config.Image}}{{"\t"}}{{.Image}}'` 取三欄（`.Name` 去掉開頭 `/`），再以 `docker image inspect -f '{{join .RepoDigests ","}}' <imageId>` 取第 4 欄。輸出 `容器名\tConfig.Image\timageId\tRepoDigests`。檔頭註解比照現有慣例標明「格式未在真實 Docker 上驗證前，以首次實跑為準」。
  - `vm-dump.ts` 解析 `images` 區段（只做字串切割；第 4 欄以 `,` 切分、去空白、去空字串）。
  - `planImageScans`：依 `imageId` 分組（同 imageId 合併容器名），挑 digest 規則如測試。

- [ ] **Step 4: 跑測試確認通過**（同 Step 2 指令）Expected: PASS

- [ ] **Step 5: Commit**

  ```bash
  git add scripts/security/collect-vm.sh src/core/security/collect/vm-dump.ts src/core/security/collect/images.ts src/core/security/types.ts tests/core/security/collect/images.test.ts tests/core/security/collect/vm-dump.test.ts tests/scripts/security-collect-vm.test.ts
  git commit -m "feat(security): VM 收集執行中容器的映像檔 digest"
  ```

### Task 3: `deps` 判燈（純函式）

**Files:**
- Create: `src/core/security/deps.ts`
- Modify: `src/core/security/types.ts`
- Test: `tests/core/security/deps.test.ts`

**Interfaces:**
- Consumes: Task 1 `ImageScanSummary`、`DepCounts`；Task 2 `ScanTarget`。
- Produces（`types.ts`）：
  ```ts
  export type RunnerCheckKey = 'deps'
  export type CheckKey = JudgedCheckKey | ComputedCheckKey | RunnerCheckKey | 'cert'
  export interface ImageDeps {
    image: string; digest: string | null; containers: string[]
    error?: string; counts?: DepCounts; packages?: DepPackage[]
  }
  ```
  `Finding.check` 型別維持 `CheckKey`（已涵蓋 deps）。
- Produces（`deps.ts`）：`export function evaluateDeps(input: { images: ImageDeps[] } | { failed: true } | { none: true }): Evaluation`（`Evaluation` 為既有 `{ check, findings }`）。

- [ ] **Step 1: 寫失敗測試**（`deps.test.ts`，逐列對應 spec §5.3）
  - 任一映像檔 `counts.critical > 0` → `bad`，即使另一映像檔有 `error`。
  - 無 critical、有 high → `warn`。
  - 無 critical／high、有一個 `error` → `unknown`。
  - 只有 moderate／low／unscored → `ok`；`images: []`（有 Docker 但沒容器）→ `na`。
  - `{ none: true }` → `na`；`{ failed: true }` → `unknown`，summary `'無法取得容器映像檔清單'`。
  - summary：`3 個映像檔：critical 2、high 5（asia-east1-docker.pkg.dev/altinvest/backend/app）；1 個未能掃描` 這種格式——斷言含「critical 2」「high 5」「1 個未能掃描」，括號內列出有 critical／high 的映像檔（最多 3 個，超過以「等」結尾），且長度 ≤ `MAX_SUMMARY`（`constants.ts`）。
  - findings：每個有 critical 的映像檔一筆 `{ check: 'deps', severity: 'high' }`；只有 high 的映像檔一筆 `severity: 'medium'`；title 含映像檔 repository 與數量、長度 ≤ `MAX_TITLE`；recommendation 為「升級映像檔內受影響的套件或基礎映像檔後重建部署」。無 critical／high 的映像檔不產生 finding。

- [ ] **Step 2: 跑測試確認失敗**

  Run: `pnpm vitest run tests/core/security/deps.test.ts`
  Expected: FAIL

- [ ] **Step 3: 實作 `evaluateDeps`**

- [ ] **Step 4: 跑測試確認通過**（同 Step 2）Expected: PASS；再跑 `pnpm typecheck`，修掉 `CHECK_LABEL: Record<CheckKey,…>` 缺 `deps` 的型別錯誤時**只在本 Task 加 `deps: '套件漏洞'` 標籤**（`CHECK_ORDER` 留給 Task 5）。

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/security/deps.ts src/core/security/types.ts src/core/security/view.ts tests/core/security/deps.test.ts
  git commit -m "feat(security): deps 檢查項確定性判燈"
  ```

### Task 4: Payload 契約（型別、驗證、組裝）

**Files:**
- Modify: `src/core/security/types.ts`（`SecurityScanPayload`）
- Modify: `src/core/security/payload.ts`
- Modify: `src/core/security/collect/assemble.ts`
- Test: `tests/core/security/payload.test.ts`、`tests/core/security/collect/assemble.test.ts`

**Interfaces:**
- Consumes: Task 3 `ImageDeps`、`Evaluation`。
- Produces：
  - `SecurityScanPayload.checks: Record<JudgedCheckKey, CheckResult> & { deps?: CheckResult }`；`SecurityScanPayload.deps?: ImageDeps[]`。
  - `assemblePayload(args)` 新增選填參數 `deps?: { evaluation: Evaluation; images: ImageDeps[] }`：vm 時寫入 `checks.deps = evaluation.check`、`findings` 追加 `evaluation.findings`、`payload.deps = images`。

- [ ] **Step 1: 寫失敗測試**
  - payload：vm 缺 `checks.deps` → 錯誤；vm 缺 `deps` → 錯誤；hosted 帶 `checks.deps` 或 `deps` → 錯誤；`findings[].check: 'deps'` 允許、`'cert'` 仍拒絕。
  - payload 邊界：`deps` 最多 50 個映像檔；每映像檔 `packages` ≤ 20、`containers` ≤ 50、`ids` ≤ 5；字串欄位 ≤ 300 字；`digest` 非 null 時須符合 `^sha256:[a-f0-9]{64}$`；`counts` 五個欄位皆為非負整數；有 `error` 的項目不可同時帶 `counts`／`packages`。
  - payload 大小：50 個映像檔各 20 筆 packages（欄位填到上限）的 payload `JSON.stringify` 長度 < 512 * 1024，且驗證通過。
  - assemble：vm＋`deps` 參數 → `payload.checks.deps`、`payload.deps`、findings 含 deps 那筆；hosted 傳了 `deps` 也不寫入。

- [ ] **Step 2: 跑測試確認失敗**

  Run: `pnpm vitest run tests/core/security/payload.test.ts tests/core/security/collect/assemble.test.ts`
  Expected: FAIL

- [ ] **Step 3: 實作**：`payload.ts` 新增 `parseDeps`，`parseChecks` 依 kind 處理 `deps`（`JUDGED` 常數維持三項不動），findings 白名單為 `[...JUDGED, 'deps']`。上限常數放 `payload.ts` 頂端（比照 `MAX_CONTAINERS`）。

- [ ] **Step 4: 跑測試確認通過**（同 Step 2）Expected: PASS；`pnpm typecheck` 通過。

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/security/types.ts src/core/security/payload.ts src/core/security/collect/assemble.ts tests/core/security/payload.test.ts tests/core/security/collect/assemble.test.ts
  git commit -m "feat(security): 快照 payload 支援 deps"
  ```

### Task 5: Beacon 儲存、讀取與畫面

**Files:**
- Create: `supabase/migrations/<timestamp>_security_scans_deps.sql`（`supabase migration new security_scans_deps`）
- Modify: `src/db/database.types.ts`（`pnpm db:types` 產生，勿手改）
- Modify: `src/core/security/view.ts`、`src/store/mapping.ts`、`src/store/supabase.ts`、`src/store/memory.ts`、`src/security-scan/handle-security-scan.ts`、`app/security/page.tsx`
- Test: `tests/security-scan/handle-security-scan.test.ts`、`tests/store/mapping.test.ts`、`tests/core/security/view.test.ts`、`tests/store/security-scans-memory.test.ts`、`tests/integration/security-scans-store.test.ts`

**Interfaces:**
- Consumes: Task 4 payload 型別。
- Produces：
  - `StoredCheckKey = JudgedCheckKey | ComputedCheckKey | RunnerCheckKey`；`StoredSecurityScan.deps: ImageDeps[] | null`（`NewSecurityScan` 隨之帶入）。
  - `CHECK_ORDER = ['ports','updates','logins','deps','cert','exposure','changes','logVolume']`。

- [ ] **Step 1: migration**：`alter table public.security_scans add column deps jsonb;`（nullable、無 default）。`supabase db push` → `supabase db advisors --type security`（不得新增 warning）→ `pnpm db:types`。

- [ ] **Step 2: 寫失敗測試**
  - handler：hosted payload → 存入的 `checks.deps` 為 `{ status: 'na', summary: '' }`、`deps: null`；vm payload → `checks.deps` 與 `deps` 原樣存入，findings 含 deps 那筆。
  - mapping：`row.checks` 無 `deps`、`row.deps` 為 null → `checks.deps` 補 `{ status: 'na', summary: '' }`、`deps: null`；有則原樣。
  - view：用缺 `deps` 的舊快照建 view 不 throw，`deps` 格為 `na`；`deps: bad` 的快照讓 overall 為 `bad`；todos 含 deps finding。
  - memory store／整合測試：寫入與讀回 `deps` 欄位一致（整合測試只對本地 stack 跑）。

- [ ] **Step 3: 跑測試確認失敗**

  Run: `pnpm vitest run tests/security-scan/handle-security-scan.test.ts tests/store/mapping.test.ts tests/core/security/view.test.ts tests/store/security-scans-memory.test.ts`
  Expected: FAIL

- [ ] **Step 4: 實作**：handler 在合併 `checks` 時對 hosted 補 `deps: na`，insert 帶 `deps: payload.deps ?? null`；supabase／memory insert 與 mapping 帶 `deps`；mapping 補預設；`CHECK_ORDER` 加 `deps`。`page.tsx`：在矩陣下方為最新快照有 `deps` 的服務各加一個 `<details>`（summary「{服務名} 映像檔套件漏洞」），內容逐映像檔列出 repository、對應容器、counts（或 error），以及 packages 表（name、version、ecosystem、severity、ids），沿用頁面既有 class 命名風格。

- [ ] **Step 5: 跑測試確認通過**：Step 3 指令 PASS；`pnpm typecheck` 通過；本地 stack 起著時再跑 `pnpm test:integration`（若本地 stack 未啟動，在回報中標明「整合測試未跑」）。

- [ ] **Step 6: Commit**

  ```bash
  git add supabase/migrations/*_security_scans_deps.sql src/db/database.types.ts src/core/security/view.ts src/store/mapping.ts src/store/supabase.ts src/store/memory.ts src/security-scan/handle-security-scan.ts app/security/page.tsx tests/security-scan/handle-security-scan.test.ts tests/store/mapping.test.ts tests/core/security/view.test.ts tests/store/security-scans-memory.test.ts tests/integration/security-scans-store.test.ts
  git commit -m "feat(security): 儲存與顯示 deps 檢查項"
  ```

### Task 6: Runner 端掃描流程（scan.mts）

**Files:**
- Create: `scripts/security/lib/image-scan.ts`
- Modify: `scripts/security/scan.mts`
- Create: `tests/scripts/fixtures/security/vm/osv/`（dry-run fixture，見下）
- Modify: `tests/scripts/fixtures/security/vm/vm-dump.txt`（加 `images` 區段）
- Test: `tests/scripts/security-image-scan.test.ts`、`tests/scripts/security-scan.test.ts`

**Interfaces:**
- Consumes: Task 1 `parseOsvImageScan`、Task 2 `planImageScans`／`VmFacts.images`、Task 3 `evaluateDeps`、Task 4 `assemblePayload({ …, deps })`。
- Produces（`image-scan.ts`）：
  ```ts
  export interface ImageScanRunner { (ref: string): { ok: true; json: unknown } | { ok: false; reason: string } }
  export function dockerOsvRunner(opts: { osvBin: string; timeoutMs: number; env: NodeJS.ProcessEnv }): ImageScanRunner
  export function scanImages(targets: ScanTarget[], run: ImageScanRunner): ImageDeps[]
  ```
  - `dockerOsvRunner`：`spawnSync('docker', ['pull', ref])` → `spawnSync(osvBin, ['scan','image',ref,'--x-plugins','artifact','--x-plugins','javascript/packagejson','--format','json'])`（`maxBuffer` 256 MB）→ 不論成敗 `spawnSync('docker', ['rmi', ref])`。pull 與 scan 共用 5 分鐘預算（`timeoutMs`）。exit ∉ {0,1} 或 JSON 解析失敗 → `{ ok:false, reason }`（reason 為不含原始輸出的短句）。
  - `scanImages`：`ref === null` → `error: '無 registry digest'`；runner 失敗 → `error: reason`；`parseOsvImageScan` throw → `error: 'osv 輸出無法解析'`；否則填 `counts`／`packages`。
- `scan.mts`：環境變數 `OSV_SCANNER_BIN`（預設 `osv-scanner`）。dry-run 時改用讀檔 runner：`<dryDir>/osv/<digest 的 hex>.json`，檔案不存在 → `{ ok:false, reason:'fixture 不存在' }`。

- [ ] **Step 1: 建 dry-run fixture**：在 `vm-dump.txt` 加 `images` 區段兩行（backend 映像檔，api 與 worker 共用一個 digest；caddy 一個 digest），把 `tests/core/security/collect/fixtures/osv-caddy.json` 複製為 `tests/scripts/fixtures/security/vm/osv/<caddy digest hex>.json`、`osv-python.json` 複製為 `<backend digest hex>.json`。

- [ ] **Step 2: 寫失敗測試**
  - `security-image-scan.test.ts`（以假 runner 測 `scanImages`）：ref null、runner 失敗、解析失敗、成功四種結果的 `ImageDeps` 形狀；同一 runner 呼叫次數等於有 ref 的 target 數。
  - `security-scan.test.ts`（dry-run）：vm fixture 推送的 payload（沿用該檔攔截推送的既有方式）含 `checks.deps.status === 'bad'`（caddy fixture 有 critical）、`deps.length === 2`、backend 那筆 `containers` 含 `api` 與 `worker`；把 `vm-dump.txt` 的 `images` 區段改成 `ERROR` 的變體 → `checks.deps.status === 'unknown'` 且其他檢查照常推送；某映像檔 fixture 檔缺失 → 該映像檔帶 `error`、CLI exit code 1 但快照仍推送；hosted fixture 的 payload 不含 `deps`。

- [ ] **Step 3: 跑測試確認失敗**

  Run: `pnpm vitest run tests/scripts/security-image-scan.test.ts tests/scripts/security-scan.test.ts`
  Expected: FAIL

- [ ] **Step 4: 實作**：vm 分支在 `collectVm` 之後：`images.failed` → `evaluateDeps({ failed: true })`、images 為 `[]`；`entries === undefined` → `{ none: true }`；否則 `scanImages(planImageScans(entries), runner)` → `evaluateDeps({ images })`。結果傳入 `assemblePayload`。任一映像檔有 `error` 或 images 區段失敗 → main 回傳 1（快照照推）。log 一行 `套件掃描：映像檔 N、失敗 M`。

- [ ] **Step 5: 跑測試確認通過**（同 Step 3）Expected: PASS；`pnpm test` 全部通過、`pnpm typecheck` 通過。

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/security/lib/image-scan.ts scripts/security/scan.mts tests/scripts/security-image-scan.test.ts tests/scripts/security-scan.test.ts tests/scripts/fixtures/security/vm/vm-dump.txt tests/scripts/fixtures/security/vm/osv
  git commit -m "feat(security): 排程端逐一拉取並掃描映像檔"
  ```

### Task 7: Workflow 與文件

**Files:**
- Modify: `.github/workflows/security-scan.yml`
- Modify: `docs/api.md`（§9）→ 重生 `src/web/generated/api-doc.ts`（`pnpm docs:build`）
- Modify: `docs/superpowers/specs/2026-11-18-security-monitoring-design.md`（檢查項表、已知限制各加一行指向新 spec）
- Modify: `scripts/CLAUDE.md`（若列有檢查項／分工，補 `deps` 由排程端確定性計算）

- [ ] **Step 1: workflow**
  - scan job `timeout-minutes: 15` → `45`。
  - 在「安裝 gcloud」之後新增兩個 `if: matrix.target.kind == 'vm'` 的 step：
    1. 「設定 Artifact Registry 登入」：`gcloud auth configure-docker asia-east1-docker.pkg.dev --quiet`。
    2. 「安裝 osv-scanner」：`curl -fsSL -o "$RUNNER_TEMP/osv-scanner" <Global Constraints URL>`，`echo "<sha256>  $RUNNER_TEMP/osv-scanner" | sha256sum -c -`，`chmod +x`，並 `echo "OSV_SCANNER_BIN=$RUNNER_TEMP/osv-scanner" >> "$GITHUB_ENV"`。
  - 「掃描」step 不需新增 env（`OSV_SCANNER_BIN` 已由 `GITHUB_ENV` 帶入）。

- [ ] **Step 2: 驗證 workflow 語法**

  Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/security-scan.yml'))"`
  Expected: 無錯誤輸出；另以 `grep -n "pull_request\|push:" .github/workflows/security-scan.yml` 確認沒有出現新觸發。

- [ ] **Step 3: 文件**：`docs/api.md` §9 的 body 範例加 `checks.deps`、`deps`，欄位限制段寫入 Task 4 的上限，「哪些狀態由 beacon 計算」段補「`deps` 由排程端確定性計算、vm 必填、hosted 不得帶（beacon 補 na）」；標明快照只由 th-beacon 自己的掃描 workflow 送出。`pnpm docs:build` 重生 api-doc。

- [ ] **Step 4: 全面驗證**

  Run: `pnpm test && pnpm typecheck && pnpm build`
  Expected: 全部通過。

- [ ] **Step 5: Commit**

  ```bash
  git add .github/workflows/security-scan.yml docs/api.md src/web/generated/api-doc.ts docs/superpowers/specs/2026-11-18-security-monitoring-design.md scripts/CLAUDE.md
  git commit -m "feat(security): workflow 安裝 osv-scanner 並登入 Artifact Registry；文件補 deps"
  ```

## 交付後由使用者執行（不在任務內）

- 授予掃描服務帳號 `roles/artifactregistry.reader`（限 `altinvest/backend`、`altinvest/frontend`、`altinvest/grid-bot` 三個 repository）。
- spec §7 驗收第 3、3a、4 項：對真實映像檔實跑、確認 VM 容器皆有 RepoDigests、`workflow_dispatch` 實跑並目視 `/security`。
