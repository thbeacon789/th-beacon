/**
 * 建置期把 docs/api.md 轉成一個 TypeScript 模組，供 /docs 頁面直接 import。
 *
 * 為什麼是建置期而不是執行期讀檔：Next.js 用靜態分析決定哪些檔案要進 serverless
 * bundle，`fs.readFileSync('docs/api.md')` 這種路徑字串它追不到——本地跑得好好的，
 * 部署到 Vercel 才 500。轉成模組後是一般 import，靜態分析追得到，這個失敗模式
 * 連同 outputFileTracingIncludes 設定一起消失，marked 也只需留在 devDependencies。
 *
 * 由 package.json 的 prebuild 觸發（`pnpm build` 前自動執行）。產物有進版控，
 * 所以 `pnpm dev` 不必先轉檔；線上則因每次 build 都重跑而恆為最新。
 *
 * 用 node 原生 TypeScript type stripping 直接執行，不引入 tsx。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked, type Token, type Tokens } from 'marked'
import { createSlugger } from '../src/web/doc-slug.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'docs/api.md')
const OUTPUT = join(ROOT, 'src/web/generated/api-doc.ts')

/** 目錄與頁首標題要顯示的是文字，不是 markdown 記號 */
function stripInline(text: string): string {
  return text.replace(/[`*_~]/g, '').trim()
}

const markdown = readFileSync(SOURCE, 'utf8')
const tokens = marked.lexer(markdown)

// 首個 h1 改由頁面的 .page-head 呈現，否則同一頁會出現兩個標題。
// 用 splice 原地移除而非 filter：marked.parser 需要 lexer 掛在陣列上的 links 屬性，
// 重建陣列會把它弄丟。
const h1Index = tokens.findIndex((t: Token) => t.type === 'heading' && t.depth === 1)
const title =
  h1Index === -1 ? 'API 參考' : stripInline((tokens[h1Index] as Tokens.Heading).text)
if (h1Index !== -1) tokens.splice(h1Index, 1)

// 依文件順序算出每個 h2/h3 的錨點 id。HTML 端只做順序對應，不重算 slug，
// 兩邊自然一致。
const slug = createSlugger()
const headings = tokens
  .filter((t: Token): t is Tokens.Heading => t.type === 'heading' && (t.depth === 2 || t.depth === 3))
  .map((t: Tokens.Heading) => ({ depth: t.depth, text: stripInline(t.text), id: slug(t.text) }))

const html = marked.parser(tokens)

// 依序把 id 補進標題標籤。marked 產出的形式是 <h2>…</h2>，與 headings 同序。
let cursor = 0
const htmlWithAnchors = html.replace(
  /<(h[23])>/g,
  (match: string, tag: string) => {
    const heading = headings[cursor++]
    return heading === undefined ? match : `<${tag} id="${heading.id}">`
  },
)
if (cursor !== headings.length) {
  throw new Error(`標題數對不上：HTML 有 ${cursor} 個、tokens 有 ${headings.length} 個`)
}

// 表格包進既有的 .table-wrap：全域 table 有 min-width: 40rem，不包起來手機版會被撐爆
// （既有頁面都是手寫這層 wrapper，marked 不會產）。
const htmlWithTables = htmlWithAnchors
  .replace(/<table>/g, '<div class="table-wrap"><table>')
  .replace(/<\/table>/g, '</table></div>')

// 目錄只收 h2：文件有五個章節，十幾個 h3 全列出來反而找不到東西
const toc = headings.filter((h) => h.depth === 2).map(({ id, text }) => ({ id, text }))

const banner = `// 自動產生，勿手改。來源：docs/api.md，產生器：scripts/build-docs.mts
// 修改文件請改 docs/api.md，然後跑 pnpm build（prebuild 會重新產生本檔）。`

const contents = `${banner}

export const API_DOC_TITLE = ${JSON.stringify(title)}

export const API_DOC_BUILT_AT = ${JSON.stringify(new Date().toISOString())}

export const API_DOC_TOC: readonly { readonly id: string; readonly text: string }[] = ${JSON.stringify(toc, null, 2)}

export const API_DOC_HTML = ${JSON.stringify(htmlWithTables)}

/** 下載端點回傳的原始 markdown（未經 token 增刪，與 docs/api.md 逐字相同） */
export const API_DOC_MARKDOWN = ${JSON.stringify(markdown)}
`

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, contents, 'utf8')

console.log(`build-docs: ${headings.length} 個標題、${toc.length} 個章節 → src/web/generated/api-doc.ts`)
