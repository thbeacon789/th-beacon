import type { ReactNode, SVGProps } from 'react'

/**
 * 專案內建的 icon 系統。刻意不引外部套件：
 * 只需少數幾個符號，且要能沿用像素風的直角收邊（square cap / miter join）。
 * 共同約定：24 格 viewBox、線條式、顏色一律 currentColor（由外層文字色決定）、
 * 一律 aria-hidden——每個 icon 旁都有文字，icon 本身不承載語意。
 */
type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }

function Icon({ size = 20, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 12h17" />
      <path d="M13 5l7 7-7 7" />
    </Icon>
  )
}

export function ExternalLinkIcon({ size = 16, ...props }: IconProps) {
  return (
    <Icon size={size} {...props}>
      <path d="M11 4H4v16h16v-7" />
      <path d="M14 3h7v7" />
      <path d="M21 3l-9 9" />
    </Icon>
  )
}

/** healthy：圓形打勾 */
export function HealthyIcon({ size = 16, ...props }: IconProps) {
  return (
    <Icon size={size} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 5-6" />
    </Icon>
  )
}

/** degraded：三角驚嘆號——與 healthy 的圓形在外輪廓上就能區分，不靠顏色 */
export function DegradedIcon({ size = 16, ...props }: IconProps) {
  return (
    <Icon size={size} {...props}>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v4" />
      <path d="M12 17.5v.5" />
    </Icon>
  )
}

/** down：八角形叉叉（停止號輪廓） */
export function DownIcon({ size = 16, ...props }: IconProps) {
  return (
    <Icon size={size} {...props}>
      <path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z" />
      <path d="M9 9l6 6" />
      <path d="M15 9l-6 6" />
    </Icon>
  )
}
