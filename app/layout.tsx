import type { ReactNode } from 'react'
import './globals.css'
import { auroraBC, newGen } from '@/web/fonts'
import { RealtimeRefresh } from '@/web/realtime-refresh'
import { NavBar } from '@/web/nav'

export const metadata = { title: 'th-beacon' }

export default function RootLayout({ children }: { children: ReactNode }) {
  // suppressHydrationWarning：瀏覽器擴充會在 hydrate 前於 <html> 注入屬性；只抑制此元素自身的屬性比對，不影響子樹
  return (
    <html lang="zh-Hant" suppressHydrationWarning>
      <body className={`${auroraBC.variable} ${newGen.variable}`}>
        <NavBar />
        <div className="container">{children}</div>
        <RealtimeRefresh />
      </body>
    </html>
  )
}
