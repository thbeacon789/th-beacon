# 映像檔相依套件漏洞掃描（`deps` 檢查項）設計

日期：2026-11-24
狀態：使用者已核准（2026-11-24）
前置：`docs/superpowers/specs/2026-11-18-security-monitoring-design.md`（資安監控，以下稱「母 spec」）

## 1. 意圖與動機

資安監控的「待更新」（`updates`）對 VM 目標只看主機的 apt 系統套件。VM 上實際提供服務的是 Docker 容器（altinvest：backend 的 api／cron／worker、frontend、grid-bot、caddy 等），容器內的應用程式相依套件與映像檔內的系統套件完全沒有被監控。

使用者要的是：**專案相依套件中有已知漏洞的，要被看見，而且燈號要準確**。「準確」在討論中被定義為：**反映線上實際部署的東西**，而不是 repo main 分支宣告了什麼。

本地實測佐證這個定義（2026-11-24）：

- frontend 是 Next.js standalone 輸出，映像檔只帶 build 追蹤到的套件，dev 套件不在其中。
- grid-bot 是 Go，映像檔只有編譯好的執行檔；掃 `go.mod` 會多算測試用套件。
- backend 的 `Dockerfile:12` 是 `yarn install --frozen-lockfile`、未排除 dev 套件，**dev 套件真的在線上映像檔內**。
- 掃 lockfile 無法區分 dev 套件（osv-scanner 輸出無 dev 標記，`[[PackageOverrides]] group="dev"` 實測無效）：backend lockfile 掃出 104 個有漏洞套件／43 筆 critical，多為 dev 工具。

## 2. 目標、非目標、反目標

**目標**

- 新增檢查項 `deps`（標籤「套件漏洞」），對 VM 目標上**每個執行中容器所用的映像檔**做漏洞掃描，涵蓋：映像檔內的 npm 套件（`node_modules`）、Go 執行檔編譯進的模組、映像檔的 OS 套件（Alpine apk 等）。
- 只算**有已知漏洞**者；版本落後但無漏洞不列。
- 燈號依確定性規則判定（純函式），不經 Claude 判讀。
- `/security` 矩陣多一欄 `deps`，能看出哪個映像檔、哪些套件、什麼等級。

**非目標**

- hosted 目標（Vercel 等無映像檔者）：維持現有 `updates` 的 pnpm／npm audit，不改。
- 主機層級的 apt 檢查（`updates`）：不改，與 `deps` 並存（伺服器 vs 容器）。
- 自動開升級 PR、修復建議以外的自動化。
- 呼叫分析（reachability，例如 `--call-analysis=go`）：本版不做。
- 不發 Discord、不進 issue 管線（與母 spec 一致）。

**反目標（技術上能跑但算失敗）**

- 掃到的不是線上正在跑的那個版本（例如掃 `:latest` 或 repo main）。
- 讀不懂／拉不到時顯示「正常」。任何收集失敗都必須呈現為 `unknown`，不可誤報為 `ok`。
- 掃描過程執行目標映像檔或目標 repo 的任何程式碼。

## 3. 限制

- `src/core/security/**` 為純函式、禁 I/O 與 `Date.now`，且只用相對路徑加 `.ts` 副檔名 import（Node 直接執行 `.mts`）。
- workflow 不得加 `pull_request`／`push` 觸發；第三方 action 釘 commit SHA；外部執行檔釘版並驗 checksum。
- 快照 body 上限 512 KB（`docs/api.md` §9）。
- 外部事實須查證；以下標「已實測」者為 2026-11-24 在 macOS 以 osv-scanner v2.7.1 對公開映像檔（`caddy:2-alpine`、`node:22.23.5-alpine`）、一個以 `python:3.11-slim-trixie` 建立並在 `/.venv` 裝套件的測試映像檔，以及 altinvest 兩個 lockfile 實跑；**尚未對 altinvest 的真實映像檔實跑**。
- 範圍只有 `security/targets.json` 現有的 altinvest VM。funding-bot（`chatxbuy/funding-bot`，Python／poetry）部署在另一個 GCP 專案 `kaguya-378512` 的 `instance-prod`，而 workflow 的 `GCP_PROJECT`／`GCP_ZONE`／`GCP_INSTANCE` 目前是全域單一組，無法掃第二台 VM。「多台 VM、跨 GCP 專案」另開 spec（使用者 2026-11-24 決定拆開），funding-bot 在那份接入；本功能的映像檔掃描已驗證可涵蓋 Python 映像檔，屆時不需再改 `deps`。

## 4. 考慮過的做法

| 做法 | 取捨 | 結論 |
|---|---|---|
| A1. 依套件管理工具跑 audit（加 Yarn Berry 路徑） | 沿用架構；但須在 runner 執行目標 repo 指定的 yarn 版本、多寫 parser、每多一種語言再加一條路；仍分不出 dev | 否決 |
| A2. osv-scanner 掃 repo lockfile | 一套工具涵蓋多格式、不執行套件管理器；但分不出 dev，backend 長期紅燈；掃的是 main 而非線上版本 | 使用者先選，後因「燈號要準確」改選 B |
| A2'. lockfile＋自行從 `dependencies` 走相依圖排除 dev | 燈號較準；但每種 lockfile 要寫圖解析器，且 backend 會被判「沒問題」而實際 dev 套件在線上映像檔內 | 否決（準確是表面的） |
| A3. 讓套件管理器產生正式環境清單 | 須在 runner install 目標 repo，執行其程式碼 | 否決（違反安全原則） |
| **B. osv-scanner 掃線上執行中的映像檔（依 digest）** | 量的就是線上實際內容；dev 排除自然成立（或如實暴露 backend 的問題）；附帶掃到 OS 套件；不需 checkout repo／deploy key。代價：VM 收集要回報 digest、runner 要能拉映像檔（GCP 權限） | **採用**（使用者 2026-11-24 選定） |

## 5. 已決定的部分

### 5.1 工具與參數（已實測）

- osv-scanner **v2.7.1**，下載 `https://github.com/google/osv-scanner/releases/download/v2.7.1/osv-scanner_linux_amd64`，以同 release 的 `osv-scanner_SHA256SUMS` 驗證（linux_amd64 預期 `fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8`）。
- 指令：`osv-scanner scan image <ref> --x-plugins artifact --x-plugins javascript/packagejson --format json`
  - 預設 plugin（`artifact`）**不會**盤點 `node_modules` 的 npm 套件（實測：node 映像檔僅回報 Alpine）；加 `javascript/packagejson` 後才會（實測：198 個 npm 套件）。兩者都要帶。
  - `scan image` 若本機無該映像檔會自行 pull；亦支援 `--archive` 掃 tar。
  - 已實測涵蓋的生態系：npm（需上述 plugin）、Go 執行檔（buildinfo）、PyPI（venv 與系統 site-packages 的 `dist-info`，預設即可，不需額外 plugin；`--x-plugins python` 不是有效值，exit 127）、Alpine（apk）、Debian（dpkg）。
- exit code：0＝無漏洞、1＝有漏洞（皆為成功）；127＝一般錯誤、128＝沒找到套件、129–255 其他錯誤（官方 docs/output.md）。成功與否以 exit code ∈ {0,1} 且 stdout 為可解析 JSON 為準。
- JSON：`results[].source{path,type}`、`results[].packages[].package{name,version,ecosystem}`、`.vulnerabilities[]`（完整 OSV 紀錄）、`.groups[]{ids,aliases,max_severity}`。同一弱點的多個 id（GHSA／CVE／GO-）已由 `groups` 合併，**計數以 group 為單位**，不以 vulnerability 為單位。

### 5.2 嚴重度換算（已實測）

每個 group 的等級，依序取：

1. 組內 vulnerability 的 `database_specific.severity`（GHSA 有；npm 漏洞實測全有）取最高，對應 `LOW→low`、`MODERATE→moderate`、`HIGH→high`、`CRITICAL→critical`。
2. 否則用 group 的 `max_severity`（CVSS 分數字串）：≥9.0 critical、≥7.0 high、≥4.0 moderate、>0 low（CVSS v3 qualitative rating 區間）。Alpine 與部分 Go 漏洞走這條（實測）。
3. 皆無（`max_severity` 為空字串，實測部分 `GO-` 漏洞如此）→ `unscored`。

**去重**：同一套件同版本可能出現在映像檔多個路徑（實測：venv 與系統 site-packages 各有一份 `pip-24.0`），每個結果也會重複列出。每個映像檔的計數以 `(ecosystem, name, version, group 的 ids 排序後串接)` 為鍵去重；`packages` 明細以 `(ecosystem, name, version)` 去重。

**全部照算（使用者 2026-11-24 決定）**：沒有修正版可升的漏洞、Debian 標為 `unimportant` 的漏洞，一律依等級計入燈號，不另外過濾。實測乾淨的 `python:3.11-slim-trixie` 映像檔就有 213 個 OS 漏洞群組（critical 2、high 95，其中 critical 皆無修正版），因此 Debian 系映像檔預期長期 `bad`；這是已知且接受的結果。

### 5.3 燈號規則（`deps`，純函式）

| 條件 | 狀態 |
|---|---|
| 任一映像檔有 critical | `bad` |
| 否則任一有 high | `warn` |
| 否則任一映像檔掃描失敗／拉不到／無 digest | `unknown` |
| 否則（只有 moderate／low／unscored 或完全沒有） | `ok` |
| 目標非 VM，或 VM 上沒有 Docker／沒有容器 | `na` |
| 容器清單本身收集失敗 | `unknown` |

「critical/high 優先於 unknown」的理由：已確認的嚴重漏洞比「部分沒掃到」更該被看見；summary 須同時註明有幾個映像檔沒掃到。

summary 範例：「3 個映像檔：critical 2、high 5（backend/app）；1 個未能掃描」。

**這組門檻是設計者的提議，使用者可改。**

### 5.4 掃描範圍

- 掃 VM 上**每個執行中容器**的映像檔，含第三方映像檔（caddy、redis 等）——它們同樣在線上執行。
- 以 digest 去重：api／cron／worker 共用同一映像檔，只掃一次，結果標示對應的容器名稱。
- 停止中的容器不掃（與 `containers` 清單一致）。

### 5.5 資料流

```
VM（collect-vm.sh 新 section images）
  每個執行中容器：容器名、Config.Image、image ID、RepoDigests
     ↓ 經現有 IAP SSH dump
runner（scan.mts）
  依 digest 去重 → 對每個 <repo>@sha256:<digest>：osv-scanner scan image（pull by digest）
  → 純函式解析（src/core/security/collect/osv.ts）→ 每映像檔摘要
  → 純函式判燈（src/core/security/deps.ts）→ checks.deps ＋ findings ＋ deps 明細
     ↓ POST /api/security-scan（HMAC，既有）
beacon：payload 驗證 → 存 security_scans（新欄位 deps）
讀取端：CHECK_ORDER 加 deps；舊快照缺 deps 時補 { status:'unknown', summary:'' }（或 na，見 §6）
```

`deps` 在 **runner 端**確定性計算後放進 payload（不同於 logVolume 等在 beacon 寫入時算）：因為原始 osv 輸出太大不能上傳，判燈所需的就是摘要本身，beacon 無從重算。

### 5.6 VM 收集（`collect-vm.sh`）

新增 section `images`，**不要**把 digest 加進既有的 `containers`：`changes` 檢查會比對容器清單，加了 digest 會讓每次部署都被當成「變動」。

每行：`容器名 \t Config.Image \t image ID \t RepoDigests（逗號分隔，可為空）`。docker 呼叫沿用現有慣例（`timeout 20`、`NONE`／`ERROR` 語意、不可信輸入不拿來組指令）。

從 RepoDigests 中挑出與 `Config.Image` 同 repository 的那一筆作為掃描 ref；沒有 RepoDigests（本機 build 的映像檔）→ 該映像檔 `unknown`（原因「無 registry digest」）。

### 5.7 拉映像檔與權限

- Artifact Registry（`asia-east1-docker.pkg.dev/altinvest/{backend,frontend,grid-bot}/app`）：沿用 vm job 既有的 Workload Identity 憑證，以 `gcloud auth configure-docker asia-east1-docker.pkg.dev` 讓 docker／osv-scanner 拉取。**使用者須授予掃描用服務帳號 `roles/artifactregistry.reader`**（範圍盡量限縮在這三個 repository）。
- Docker Hub 等公開映像檔：匿名拉取。
- 以 `<repo>@sha256:<digest>` 拉取，確保掃的是線上那一版。
- 拉取與掃描都不執行映像檔（不 `docker run`）。
- 【設計者決定】workflow 在既有「安裝 gcloud」之後加一個 vm 限定 step：`gcloud auth configure-docker asia-east1-docker.pkg.dev --quiet`，並下載、驗證 osv-scanner。掃描本身由 `scan.mts` 以 `spawnSync` 依序執行：`docker pull <ref>` → `osv-scanner scan image <ref> …`（本機已有映像檔時 osv-scanner 不再 pull）→ `docker rmi <ref>`。逐一拉、掃、刪，避免 runner 磁碟（約 14 GB）被多個映像檔塞滿。
- 【設計者決定】逾時：單一映像檔的 pull＋掃描上限 **5 分鐘**，job 的 `timeout-minutes`（目前 `security-scan.yml:46` 為 15）調為 **45**。序列執行（不並行），以免同時佔用磁碟。逾時的映像檔記為 `error`。

### 5.8 Payload 與儲存

- payload 新增選填 `deps`（僅 vm）：
  ```
  deps: Array<{
    image: string            // 不含 digest 的 repository，例：asia-east1-docker.pkg.dev/altinvest/backend/app
    digest: string | null    // sha256:...；無則 null
    containers: string[]     // 使用此映像檔的容器名
    error?: string           // 掃描失敗原因（短句），有此欄則下列欄位省略
    counts?: { critical, high, moderate, low, unscored }  // 以 group 計
    packages?: Array<{ name, version, ecosystem, severity, ids: string[] }>  // 依嚴重度排序，每映像檔最多 20 筆
  }>
  ```
- `checks.deps` 隨 payload 送出；payload 的 `checks` 型別與 `findings.check` 白名單需允許 `deps`（現在只允許 Judged 三項，見 `types.ts:36-37`、`payload.ts:13`）。
- 【設計者決定】型別：新增第三類 `RunnerCheckKey = 'deps'`（排程端確定性計算、不經 Claude），**不併入 `JudgedCheckKey`**——`JUDGED` 也驅動 `judge.ts` 對 Claude 的輸出 schema，併入會要求 Claude 輸出 deps。`CheckKey`、`StoredCheckKey` 都納入 `deps`。payload 的 `checks` 型別改為 `Record<JudgedCheckKey, CheckResult> & { deps?: CheckResult }`，findings 白名單為 Judged ∪ `deps`。
- 【設計者決定】必填規則：`kind: 'vm'` 的 payload **必須**帶 `checks.deps` 與 `deps`（失敗時帶 `unknown` 與各映像檔的 `error`，不可省略）；`kind: 'hosted'` **不得**帶，beacon 寫入時補 `{ status:'na', summary:'' }`。runner 與 beacon 在同一 repo、同一次 push 部署，故沒有新舊版並存的過渡期。
- 【設計者決定】`deps[].containers` 是 deps 專用的對應資訊，與 `inventory.containers` 各自獨立、允許不一致（兩者在不同時刻收集）；`images` section 不進 `inventory`，不參與 `changes` 比對。
- findings：每個有 critical／high 的映像檔產生一筆（severity：critical→high、high→medium），title 含映像檔名與數量，recommendation 指向升級或重建映像檔。
- DB：`security_scans` 新增 `deps jsonb`（nullable）。migration 走 `supabase migration new` → `db push` → advisors → `pnpm db:types`。
- 大小：每映像檔 20 筆套件 × 約 10 個映像檔，遠低於 512 KB；payload 驗證仍須設上限（映像檔數、字串長度）。

### 5.9 舊快照相容

讀取端目前**不容錯**：舊快照缺 `checks.deps` 會在 `view.ts:143` 與 `app/security/page.tsx:79-80` 丟 TypeError，整頁壞掉。

【設計者決定】在 `rowToSecurityScan`（`src/store/mapping.ts:213`）逐列補 `checks.deps = { status:'na', summary:'' }`（缺才補）。依 §5.8 必填規則，新版寫入的 vm 快照一定帶 deps，因此「缺 deps」只可能是本功能上線前的舊快照，補 `na` 即正確，不需要知道是不是最新一筆。舊快照的 `deps` 明細欄位為 null，詳情處顯示「此快照無套件掃描」。

### 5.10 失敗行為

- osv-scanner 下載或 checksum 不符：整個 `deps` 為 `unknown`，job 以非 0 結束（與 audit 失敗同等級處理）。
- 單一映像檔拉取／掃描失敗：該映像檔 `error`，其餘照常；job 以非 0 結束以便在 Actions 看見。
- 單一映像檔掃描逾時：上限 5 分鐘（見 §5.7），逾時記為該映像檔 `error`。
- `images` section 失敗：`deps` 為 `unknown`；不影響其他檢查。

### 5.11 文件

- `docs/api.md` §9：payload 新增 `deps` 與 `checks.deps`，說明由排程端計算、vm 必填、hosted 不得帶。§9 也是 onboarding skill 的參考資料，須標明「快照只由 th-beacon 自己的掃描 workflow 送出，其他 repo 接入時不需實作此端點」（若 §9 已有類似說明則沿用）。改完重生 `src/web/generated/api-doc.ts`（勿手改）。`security_scans` 的 90 天保留策略不變。
- 母 spec 的檢查項表與「已知限制」補一行指向本文件；`scripts/CLAUDE.md` 若描述檢查項清單則同步。

## 6. 留給實作者的判斷

- `osv.ts` 解析的防禦程度：結構不符一律 throw（比照 `audit.ts` 的「讀不懂不回 0」原則）。
- `images` section 的確切 docker 指令與格式（需在真實 Docker 上驗證，比照現有 section 的註記慣例）。
- 矩陣 UI：`deps` 若無特例，沿用 `CHECK_ORDER.map` 自動帶出；詳情處是否顯示每映像檔分列，由實作者依現有 logVolume 詳情的做法決定。

## 7. 驗收（上線前）

1. 單元測試：`osv.ts`（以實測的 JSON 片段為 fixture：GHSA 標籤、CVSS fallback、空 max_severity、group 去重）、`deps.ts`（§5.3 每一列）、payload 驗證、舊快照相容。
2. `scan.mts --dry-run` 以 fixture 跑通含 `deps` 的完整 payload。
3. 在本機對 altinvest 真實映像檔（三個 Artifact Registry 映像檔各取線上 digest）跑 osv-scanner，確認 npm 與 Go 套件都被盤點，backend 的 dev 套件出現在結果中、frontend 沒有。通過標準是「盤點正確」，**不是**「燈號為綠」：backend 因 dev 套件在映像檔內而呈紅燈是預期結果（如實反映線上），修法在 backend 的 Dockerfile，不在本功能。
3a. 在 VM 上確認每個執行中容器都有 RepoDigests（Docker 29 的 containerd image store 行為須以真機為準）；若有容器沒有，該映像檔會長期 `unknown`，須在驗收時列出並決定處理方式。
4. 使用者授予 `roles/artifactregistry.reader` 後，`workflow_dispatch` 實跑一次，`/security` 目視確認 `deps` 欄與明細。

## 8. 已知限制

- 只掃執行中的映像檔；cron 類短命容器若掃描當下未執行則漏掃。
- `javascript/packagejson` 盤點的是映像檔內所有 `package.json`，含基礎映像檔自帶的 npm／corepack／yarn——它們確實在線上映像檔內，故計入；若造成雜訊，未來可依 `source.path` 前綴排除，本版不做。
- 部分 Go 漏洞無 CVSS 分數，只能列為 `unscored`，不影響燈號。
- 燈號不區分「有修正版可升」與「無修正版」：Debian 等 OS 漏洞多的基礎映像檔會長期紅燈，紅燈不一定代表有可執行的修正。若日後覺得雜訊過大，可改為只讓有修正版者影響燈號（OSV 的 `affected[].ranges[].events[].fixed` 可判斷），本版不做。
- 漏洞資料來自 api.osv.dev（線上查詢），掃描時會把映像檔內的套件名稱與版本送給 Google。
- runner 不限制可拉取的 registry：被入侵的 VM 可讓 runner 拉任意映像檔，靠 job 逾時與磁碟逐一刪除緩解。
- 掃描帳號新增 Artifact Registry 讀取權，取得該權杖者可下載這些映像檔（內含程式碼）。
