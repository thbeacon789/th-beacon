import type { ReactNode } from 'react'

export const metadata = { title: 'th-beacon' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  )
}
