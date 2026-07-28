import type { ReactNode } from 'react'
import Link from 'next/link'
import './globals.css'
import { auroraBC, newGen, pixel12x10 } from '@/web/fonts'
import { RealtimeRefresh } from '@/web/realtime-refresh'

export const metadata = { title: 'th-beacon' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className={`${auroraBC.variable} ${newGen.variable} ${pixel12x10.variable}`}>
        <nav className="nav">
          <span className="brand">th-beacon</span>
          <Link href="/">服務總覽</Link>
          <Link href="/issues">檢傷列表</Link>
          <form action="/auth/signout" method="post">
            <button type="submit">登出</button>
          </form>
        </nav>
        <div className="container">{children}</div>
        <RealtimeRefresh />
      </body>
    </html>
  )
}
