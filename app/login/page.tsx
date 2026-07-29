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
        <h1>Transfer Helper Beacon</h1>
        <p className="hint">服務監控儀表板｜僅限白名單帳號</p>
        <GoogleLoginButton />
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  )
}
