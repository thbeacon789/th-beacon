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
        <GoogleLoginButton />
        {error !== null && <p className="error">{error}</p>}
      </div>
    </main>
  )
}
