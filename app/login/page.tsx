import { GoogleLoginButton } from '@/web/google-login-button'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const error = typeof params.error === 'string' ? params.error : null

  return (
    <main className="login">
      <div className="card login-card">
        <h1>th-beacon</h1>
        <p className="hint">僅限白名單內的 Google 帳號登入</p>
        <GoogleLoginButton />
        {error !== null && <p className="error">{error}</p>}
      </div>
    </main>
  )
}
