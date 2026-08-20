/**
 * Bounded error classification.
 *
 * Provider SDK errors routinely carry request URLs, provider identifiers, and response fragments in
 * their message. Serialising them into production logs leaks that detail, so every logged failure is
 * reduced to one of a fixed set of codes. Development keeps a short message for debugging; production
 * keeps the code only.
 *
 * Classification is context aware. A refused TCP connection means something different depending on
 * who was being called: from a database call it is a database outage, and from a Twilio, Stripe,
 * OpenAI, Google, or ezyVet call it is a provider outage. A single context-free classifier reported
 * every provider network failure as `database_unavailable`, which sent operators to the wrong
 * dependency. The caller therefore states which boundary it was crossing.
 */

export const ERROR_CODES = [
  'provider_timeout',
  'provider_unauthorized',
  'provider_rate_limited',
  'provider_rejected',
  'provider_unavailable',
  'database_unavailable',
  'lease_conflict',
  'invalid_webhook',
  'configuration_invalid',
  'unexpected_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Closed set of call boundaries. Deliberately two values: the point is to separate "our database"
 * from "somebody else's API", not to enumerate every provider. Naming providers here would invite
 * parsing provider payloads to decide which one failed.
 */
export const ERROR_CONTEXTS = ['database', 'provider'] as const;

export type ErrorContext = (typeof ERROR_CONTEXTS)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

/** Guard for values crossing a trust boundary back into the bounded code set. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

/**
 * Normalises anything about to be persisted or logged as an error code. An unapproved value is
 * replaced rather than truncated: a shortened phone number, customer fragment, or provider response
 * is still a leak, so length is not the safety property. Only membership is.
 */
export function toErrorCode(value: unknown): ErrorCode {
  return isErrorCode(value) ? value : 'unexpected_error';
}

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

/**
 * Never returns free-form text: the result is always one of the fixed codes above. Only the error's
 * `code`, `name`, and numeric status are inspected. The message is never parsed, because message
 * text is exactly where customer and provider identifiers live.
 */
export function classifyError(error: unknown, context: ErrorContext): ErrorCode {
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
    haystack.includes('epipe') ||
    haystack.includes('fetchfailed')
  ) {
    // The one branch that has to know who was being called.
    return context === 'database' ? 'database_unavailable' : 'provider_unavailable';
  }
  if (haystack.includes('unauthor') || haystack.includes('forbidden')) {
    return 'provider_unauthorized';
  }
  if (haystack.includes('ratelimit') || haystack.includes('too_many'))
    return 'provider_rate_limited';
  if (haystack.includes('signature') || haystack.includes('webhook')) return 'invalid_webhook';
  return 'unexpected_error';
}

/** For failures raised while calling Supabase or PostgreSQL. */
export function classifyDatabaseError(error: unknown): ErrorCode {
  return classifyError(error, 'database');
}

/** For failures raised while calling Twilio, Stripe, OpenAI, Google, or ezyVet. */
export function classifyProviderError(error: unknown): ErrorCode {
  return classifyError(error, 'provider');
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
export function describeError(
  error: unknown,
  environment: string,
  context: ErrorContext = 'provider',
): SafeErrorDetail {
  const error_code = classifyError(error, context);
  if (environment === 'production') return { error_code };
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  return { error_code, error_message: message.slice(0, 200) };
}
