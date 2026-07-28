'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function NavBar() {
  const pathname = usePathname()
  if (pathname.startsWith('/login')) return null
  return (
    <nav className="nav">
      <span className="brand">Transfer Helper Beacon</span>
      <Link href="/">服務總覽</Link>
      <Link href="/issues">檢傷列表</Link>
      <form action="/auth/signout" method="post">
        <button type="submit">登出</button>
      </form>
    </nav>
  )
}
