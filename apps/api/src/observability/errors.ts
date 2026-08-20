/**
 * Bounded error classification.
 *
 * Provider SDK errors routinely carry request URLs, provider identifiers, and response fragments in
 * their message. Serialising them into production logs leaks that detail, so every logged failure is
 * reduced to one of a fixed set of codes. Development keeps a short message for debugging; production
 * keeps the code only.
 */

export const ERROR_CODES = [
  'provider_timeout',
  'provider_unauthorized',
  'provider_rate_limited',
  'provider_rejected',
  'database_unavailable',
  'lease_conflict',
  'invalid_webhook',
  'configuration_invalid',
  'unexpected_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface ErrorLike {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly name?: unknown;
  readonly status?: unknown;
  readonly statusCode?: unknown;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function classifyStatus(status: number): ErrorCode | null {
  if (status === 401 || status === 403) return 'provider_unauthorized';
  if (status === 408 || status === 504) return 'provider_timeout';
  if (status === 409) return 'lease_conflict';
  if (status === 429) return 'provider_rate_limited';
  if (status >= 400) return 'provider_rejected';
  return null;
}

/** Never returns free-form text: the result is always one of the fixed codes above. */
export function classifyError(error: unknown): ErrorCode {
  if (!error || typeof error !== 'object') return 'unexpected_error';
  const candidate = error as ErrorLike;

  const status = readNumber(candidate.status) ?? readNumber(candidate.statusCode);
  if (status !== null) {
    const fromStatus = classifyStatus(status);
    if (fromStatus) return fromStatus;
  }

  const code = readText(candidate.code);
  const name = readText(candidate.name);
  const haystack = `${code} ${name}`;

  if (
    haystack.includes('etimedout') ||
    haystack.includes('timeout') ||
    haystack.includes('abort')
  ) {
    return 'provider_timeout';
  }
  if (
    haystack.includes('econnrefused') ||
    haystack.includes('enotfound') ||
    haystack.includes('econnreset') ||
    haystack.includes('fetchfailed')
  ) {
    return 'database_unavailable';
  }
  if (haystack.includes('unauthor') || haystack.includes('forbidden')) {
    return 'provider_unauthorized';
  }
  if (haystack.includes('ratelimit') || haystack.includes('too_many'))
    return 'provider_rate_limited';
  if (haystack.includes('signature') || haystack.includes('webhook')) return 'invalid_webhook';
  return 'unexpected_error';
}

export interface SafeErrorDetail {
  readonly error_code: ErrorCode;
  /** Present outside production only. Production logs the code and nothing else. */
  readonly error_message?: string;
}

/**
 * Turns any thrown value into something safe to log. The message is included only when the process
 * is not running in production, and it is always length-bounded.
 */
export function describeError(error: unknown, environment: string): SafeErrorDetail {
  const error_code = classifyError(error);
  if (environment === 'production') return { error_code };
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  return { error_code, error_message: message.slice(0, 200) };
}
