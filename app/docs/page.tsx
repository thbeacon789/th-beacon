import { requireUser } from '@/web/supabase-server'
import { formatDateTime } from '@/web/format'
import {
  API_DOC_BUILT_AT,
  API_DOC_HTML,
  API_DOC_TITLE,
  API_DOC_TOC,
} from '@/web/generated/api-doc'

export const dynamic = 'force-dynamic'

export default async function DocsPage() {
  await requireUser()

  return (
    <main>
      <div className="page-head">
        <h1>{API_DOC_TITLE}</h1>
        <p className="hint">本頁建置於 {formatDateTime(API_DOC_BUILT_AT)}</p>
        {/*
          用 <a download> 而非 fetch：檔案由 /docs/download 這個 route handler 附
          Content-Disposition 送出，瀏覽器自己存檔，不需 client component。
        */}
        <a className="btn-cta doc-download" href="/docs/download" download>
          下載 Markdown
        </a>
      </div>

      <nav className="doc-toc" aria-label="章節目錄">
        {API_DOC_TOC.map((section) => (
          <a key={section.id} href={`#${section.id}`}>
            {section.text}
          </a>
        ))}
      </nav>

      {/*
        內容來自 repo 內版控的 docs/api.md，於建置期轉換，不含任何使用者輸入或
        DB 資料——威脅模型上等同把 JSX 寫死在這裡。若哪天內容改為來自資料庫或
        表單，這行就必須改成會過濾的渲染方式。
      */}
      <div className="doc-body" dangerouslySetInnerHTML={{ __html: API_DOC_HTML }} />
    </main>
  )
}
