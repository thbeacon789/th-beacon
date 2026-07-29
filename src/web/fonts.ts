import localFont from 'next/font/local'

export const auroraBC = localFont({
  variable: '--font-aurora-bc',
  src: '../fonts/Aurora-BC.ttf',
})

export const newGen = localFont({
  variable: '--font-new-gen',
  src: '../fonts/New-Gen.ttf',
})

// 只給總體健康度儀表的數字用（沿用 trading-stream mood meter 的字體）
export const pixel12x10 = localFont({
  variable: '--font-pixel',
  src: '../fonts/Pixel-12x10.ttf',
})
