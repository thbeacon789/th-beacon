import { formatDateTime } from '@/web/format'
import type { StoredComment } from '@/core/comments'

export function CommentThread({ comments }: { comments: readonly StoredComment[] }) {
  if (comments.length === 0) return <p className="hint">尚無留言</p>
  return (
    <ul className="comment-list">
      {comments.map((c) => (
        <li key={c.id} className="comment-item">
          <div className="comment-head">
            <strong>{c.author}</strong>
            <span className="hint">{formatDateTime(c.createdAt)}</span>
            {c.kind === 'resolve' && <span className="comment-tag">解決時備註</span>}
          </div>
          <p className="comment-body">{c.body}</p>
        </li>
      ))}
    </ul>
  )
}
