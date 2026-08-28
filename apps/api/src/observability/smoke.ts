/**
 * Non-destructive deployment smoke checks.
 *
 * This validates that a deployment is reachable and reports itself ready. It never authenticates as
 * a tenant, never writes anything, and never touches a provider: no SMS is sent, no call is placed,
 * no Checkout is created, no appointment is booked. It therefore needs no service-role key, no
 * provider credential, and no customer credential.
 */

export type SmokeCheckName = 'api_live' | 'api_ready' | 'api_release' | 'web_live';

export interface SmokeCheckResult {
  readonly detail: string;
  readonly name: SmokeCheckName;
  readonly ok: boolean;
}

export interface SmokeResponse {
  readonly body: unknown;
  readonly status: number;
}

function readStatus(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const status = (body as { status?: unknown }).status;
  return typeof status === 'string' ? status : null;
}

/** Pure so the acceptance rules are asserted directly rather than through a live deployment. */
export function evaluateSmokeCheck(
  name: SmokeCheckName,
  response: SmokeResponse | null,
): SmokeCheckResult {
  if (!response) return { detail: 'unreachable', name, ok: false };
  if (response.status !== 200) return { detail: `http_${response.status}`, name, ok: false };
  const status = readStatus(response.body);
  const expected = name === 'api_ready' ? 'ready' : 'ok';
  if (status !== expected) return { detail: `status_${status ?? 'missing'}`, name, ok: false };
  return { detail: 'ok', name, ok: true };
}

export function summarizeSmokeResults(results: readonly SmokeCheckResult[]): {
  readonly failed: readonly SmokeCheckName[];
  readonly ok: boolean;
} {
  const failed = results.filter((result) => !result.ok).map((result) => result.name);
  return { failed, ok: failed.length === 0 };
}

/**
 * Did the deployment come up as the release we intended?
 *
 * A smoke that only asks "is it healthy" passes just as happily when `up` silently kept the previous
 * image -- the failure mode the SHA-tagged build-once model exists to prevent, and the one nobody
 * notices because everything is green. The release is already in the public health body, so this
 * costs nothing and needs no credential.
 *
 * Only checked when the caller states an expectation: a smoke run against an unknown deployment
 * should not invent one.
 */
export function evaluateReleaseCheck(
  response: SmokeResponse | null,
  expectedRelease: string,
): SmokeCheckResult {
  const name: SmokeCheckName = 'api_release';
  if (!response) return { detail: 'unreachable', name, ok: false };
  if (response.status !== 200) return { detail: `http_${response.status}`, name, ok: false };
  const body = response.body;
  const actual =
    body && typeof body === 'object' ? (body as { release?: unknown }).release : undefined;
  if (typeof actual !== 'string') return { detail: 'release_missing', name, ok: false };
  // The mismatch detail names neither value: an operator can read both from their own deploy
  // command, and a smoke's output is the wrong place to start echoing identifiers.
  return actual === expectedRelease
    ? { detail: 'ok', name, ok: true }
    : { detail: 'release_mismatch', name, ok: false };
}

export function smokeTargets(input: {
  readonly apiBaseUrl: string;
  readonly webBaseUrl?: string | undefined;
}): readonly { readonly name: SmokeCheckName; readonly url: string }[] {
  const api = input.apiBaseUrl.replace(/\/+$/, '');
  const targets = [
    { name: 'api_live' as const, url: `${api}/health/live` },
    { name: 'api_ready' as const, url: `${api}/health/ready` },
  ];
  if (input.webBaseUrl) {
    const web = input.webBaseUrl.replace(/\/+$/, '');
    return [...targets, { name: 'web_live' as const, url: `${web}/api/health` }];
  }
  return targets;
}
