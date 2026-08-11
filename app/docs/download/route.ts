import { requireUser } from '@/web/supabase-server'
import { API_DOC_MARKDOWN } from '@/web/generated/api-doc'

// 內容來自建置期產物（見 scripts/build-docs.mts），但仍需逐次驗證登入，
// 故不做靜態化。middleware 已擋一層，這裡的 requireUser 是深度防禦：
// 白名單複查只在 requireUser 內做。
export const dynamic = 'force-dynamic'

export async function GET() {
  await requireUser()

  return new Response(API_DOC_MARKDOWN, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': 'attachment; filename="th-beacon-api.md"',
      // 內容隨部署更新，且需登入才可取得——不讓中間層或瀏覽器留存
      'cache-control': 'no-store',
    },
  })
}
