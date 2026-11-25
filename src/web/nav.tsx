'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

// 兩組分頁：primary 是日常盯盤用的重要頁，secondary 是設定／統計／文件
const PRIMARY_LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/issues', label: 'Issues' },
  { href: '/security', label: 'Security' },
] as const

const SECONDARY_LINKS = [
  { href: '/services', label: 'Services' },
  { href: '/ai-stats', label: 'AI Stats' },
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
        {(
          [
            ['primary', PRIMARY_LINKS],
            ['secondary', SECONDARY_LINKS],
          ] as const
        ).map(([tier, links]) => (
          <div key={tier} className={`nav-group nav-group-${tier}`}>
            {links.map((link) => (
              <Link key={link.href} href={link.href} aria-current={isActive(link.href) ? 'page' : undefined}>
                {link.label}
              </Link>
            ))}
          </div>
        ))}
      </div>
      <form action="/auth/signout" method="post">
        <button type="submit">Logout</button>
      </form>
    </nav>
  )
}
