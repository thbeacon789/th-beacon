'use client'

import { useFormStatus } from 'react-dom'

/**
 * server action 送出期間會有一段沒有畫面回饋的空窗（revalidate 完才重繪）。
 * useFormStatus 需要在 <form> 的子元件裡呼叫，所以獨立成 client component。
 */
export function SubmitButton({ children, pendingLabel }: { children: string; pendingLabel: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </button>
  )
}
