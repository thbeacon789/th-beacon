'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/issues', label: 'Triage' },
  { href: '/services', label: 'Register' },
  { href: '/docs', label: 'Docs' },
] as const

export function NavBar() {
  const pathname = usePathname()
  if (pathname.startsWith('/login')) return null
  // '/' 只在完全相符時算 active，否則每一頁都會標成當前頁
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href))
  return (
    <nav className="nav" aria-label="主要導覽">
      <span className="brand">Transfer Helper Beacon</span>
      {/* 連結包一層：手機版才好把整組連結整批換到第二列，讓 Logout 留在 brand 同一排 */}
      <div className="nav-links">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} aria-current={isActive(link.href) ? 'page' : undefined}>
            {link.label}
          </Link>
        ))}
      </div>
      <form action="/auth/signout" method="post">
        <button type="submit">Logout</button>
      </form>
    </nav>
  )
}
