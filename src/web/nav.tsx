'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/issues', label: 'Triage' },
  { href: '/docs', label: 'API' },
] as const

export function NavBar() {
  const pathname = usePathname()
  if (pathname.startsWith('/login')) return null
  // '/' 只在完全相符時算 active，否則每一頁都會標成當前頁
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href))
  return (
    <nav className="nav" aria-label="主要導覽">
      <span className="brand">Transfer Helper Beacon</span>
      {LINKS.map((link) => (
        <Link key={link.href} href={link.href} aria-current={isActive(link.href) ? 'page' : undefined}>
          {link.label}
        </Link>
      ))}
      <form action="/auth/signout" method="post">
        <button type="submit">Logout</button>
      </form>
    </nav>
  )
}
