import type { ReactNode } from 'react'
import './globals.css'
import { auroraBC, newGen } from '@/web/fonts'
import { RealtimeRefresh } from '@/web/realtime-refresh'
import { NavBar } from '@/web/nav'

export const metadata = { title: 'th-beacon' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className={`${auroraBC.variable} ${newGen.variable}`}>
        <NavBar />
        <div className="container">{children}</div>
        <RealtimeRefresh />
      </body>
    </html>
  )
}
