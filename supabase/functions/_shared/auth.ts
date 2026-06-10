// Service-role caller guard for invokable paper CTAs.
//
// These functions run behind verify_jwt = true (config.toml), so the gateway has
// already verified the bearer's SIGNATURE before we run — the payload claims are
// trustworthy. We additionally require role == 'service_role' because the public
// anon key is also a validly-signed JWT and would pass the gateway alone.
//
// Why not compare the bearer to Deno.env SUPABASE_SERVICE_ROLE_KEY (the previous
// guard)? On this platform the runtime-injected value is the new sb_secret_…
// format key, which the verify_jwt gateway REJECTS as a non-JWT — so the equality
// guard locked out every caller including the legitimate service one.
//
// ONLY safe behind verify_jwt = true: without gateway signature verification an
// attacker could forge an unsigned JWT with role=service_role.

export function isServiceRoleCaller(req: Request): boolean {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const parts = token.split('.')
  if (parts.length !== 3) return false
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      role?: unknown
    }
    return payload.role === 'service_role'
  } catch {
    return false
  }
}
