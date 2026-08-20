/**
 * Web liveness only. It proves the Next.js server is serving and reports the same safe release
 * identifier the API uses. It deliberately never touches Supabase, reads no cookie, and exposes no
 * environment value, URL, or auth state: API readiness is the endpoint that validates dependencies.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({
    release: process.env.AVENLYO_RELEASE ?? 'unknown',
    service: 'avenlyo-web',
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
}
