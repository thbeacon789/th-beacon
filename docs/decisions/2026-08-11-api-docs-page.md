# ADR：後台 API 文件頁（/docs）

- 日期：2026-08-11
- 狀態：已實作
- 相關：`docs/api.md`（內容來源）、`app/docs/page.tsx`、`scripts/build-docs.mts`

## 脈絡

`docs/api.md` 是 ingest / heartbeat / poll 三個端點的實作級契約，但它只存在於 repo 裡。需求是讓接入者在 dashboard 登入後也能讀到。

關鍵前提：**讀者就是 `allowed_emails` 白名單內的同事，他們同時也有 repo 權限**。因此這頁是便利性質，不是唯一分發管道——這條線是下面每個決策的裁決依據：值得做，但不值得為它改變專案的依賴體質。

## 決策

1. **內容單一來源**：頁面渲染 `docs/api.md`，不另寫一份頁面版內容。
2. **唯讀**：不接資料庫。不顯示服務清單、已登記心跳等實際資料。
3. **單篇 `/docs`**：不做 `/docs/[slug]` 文件區。nav 加一項 `API`。
4. **建置期轉檔 ＋ `marked`**：`prebuild` 跑 `scripts/build-docs.mts`，把 md 轉成 `src/web/generated/api-doc.ts` 供 import。`marked` 只在 devDependencies。
5. **產物進版控**：`src/web/generated/api-doc.ts` 有 commit。
6. **頁首錨點目錄 ＋ 建置時間戳**：目錄只收 h2（五個章節）；頁首顯示「本頁建置於 X」。
7. **只測 slug 純函式**：`src/web/doc-slug.ts` 有單元測試，轉檔產物不做 HTML 斷言。

## 理由與被否決的選項

### 為什麼是建置期轉檔，而不是 runtime 讀檔（決策 4）

**這是本文件最值得記住的一條。** Next.js 用靜態分析決定哪些檔案進 serverless bundle。若在 server component 裡 `fs.readFileSync('docs/api.md')`，路徑只是個字串，靜態分析追不到——**本地完全正常，部署到 Vercel 才 500**。要修得靠 `next.config.ts` 的 `outputFileTracingIncludes: { '/docs': ['./docs/api.md'] }`（Next 15 起為頂層設定，不再在 `experimental` 下）。

轉成模組後是一般 import，靜態分析追得到，這個失敗模式連同該設定一起消失，`marked` 也不必進 runtime dependencies。

**若未來有人想改回 runtime 讀檔，必須同時補上 `outputFileTracingIncludes`，否則會踩回這個只在部署後才暴露的坑。**

### 為什麼不用 react-markdown（決策 4）

`react-markdown` ＋ `remark-gfm`（表格）＋ `rehype-slug`（錨點）會把整個 unified/remark/rehype 生態拉進來（數十個小套件）。本專案 runtime dependencies 只有 5 個（`next`、`react`、`react-dom`、`@supabase/ssr`、`@supabase/supabase-js`），沒有 Tailwind、沒有任何 UI 套件。為一個內部文件頁做這種量級的擴張，與「便利性質」的定位不成比例。

`marked` 的 `dependencies` 是空的，且 `gfm` 預設為 `true`（含 GFM 表格），只有標題錨點需要自己補——就是 `src/web/doc-slug.ts` 那三十行。

`@next/mdx` 也否決：只吃 `.mdx` 副檔名、App Router 下強制要求 `mdx-components.tsx`，而且表格與錨點仍要掛同一批 unified plugin，等於換個掛載點付一樣的帳。

### 為什麼產物要進版控（決策 5）

npm 的 `pre*` hook 只綁同名 script，`prebuild` 只在 `pnpm build` 前跑，**`pnpm dev` 不會觸發**。若把產物 gitignore，dev server 會因找不到模組而編譯失敗，每次 clean checkout 都得先手動轉檔。

進版控的常見代價是「產物過期」，但在這裡幾乎不痛：Vercel 每次 build 都會跑 `prebuild` 重新產生，**線上恆為最新**，commit 版本過期只影響本地 dev 顯示。

改 `docs/api.md` 後若要讓本地同步，跑 `pnpm docs:build`。

### 為什麼 `dangerouslySetInnerHTML` 在這裡可接受（決策 4 的副作用）

內容來自 repo 內版控的 md 檔，於建置期轉換，不含任何使用者輸入或 DB 資料——威脅模型上等同把 JSX 寫死在頁面裡。**若哪天內容改為來自資料庫或表單，這個判斷立刻失效**，必須改用會過濾的渲染方式。此注意事項也寫在 `app/docs/page.tsx` 的註解裡。

### 為什麼顯示「建置時間」而非「文件最後修改時間」（決策 6）

要拿 `docs/api.md` 單一檔案的最後 commit 時間，得在 build 環境跑 `git log`，而 Vercel 預設淺層 clone 拿不拿得到需要實地驗證。為一行時間戳去賭一個部署期才會暴露的失敗不划算。建置時間語意較弱，但足以觸發警覺（「上次部署是三個月前，可是我記得上週改過 API」）。

### 為什麼不測轉檔產出（決策 7）

斷言 HTML 字串是典型的「一改就紅、卻抓不到真問題」的測試。slug 則不同：它要處理中文標題、inline code、重複標題，是會出錯的純函式，值得釘住。轉檔鏈本身由 `pnpm build` 實跑驗證。

## 後續若要擴充

- **加第二篇文件**：改成 `/docs/[slug]`，需要一份上架清單（哪些 md、標題、排序），舊連結 `/docs` 要留轉址。
- **顯示實際接入資料**（服務名、已登記心跳）：注意 `webhook_secret` 絕不可出現在頁面上——現行架構刻意讓它不出伺服器。
- **改成 runtime 讀檔**：見上方 `outputFileTracingIncludes` 的警告。
