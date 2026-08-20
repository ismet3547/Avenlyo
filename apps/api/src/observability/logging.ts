import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Production logging configuration for the existing Fastify/Pino logger. No second logging
 * framework is introduced.
 *
 * Two rules drive everything here. Nothing that can carry a credential is ever serialised, and
 * nothing that can carry customer content is ever serialised. That means request and response
 * bodies are never logged, query strings are dropped (they can carry web-chat tokens and provider
 * identifiers), and the header allowlist below is deliberately tiny.
 */

/** Header and field paths scrubbed before anything reaches a log transport. */
export const REDACTED_LOG_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["x-avenlyo-session"]',
  'req.headers["stripe-signature"]',
  'req.headers["x-twilio-signature"]',
  'req.headers["x-twilio-email-event-webhook-signature"]',
  'req.headers["webhook-signature"]',
  'req.headers["webhook-id"]',
  'req.headers["webhook-timestamp"]',
  'req.headers["openai-signature"]',
  'req.headers["x-openai-signature"]',
  'req.headers["x-supabase-authorization"]',
  'req.headers.apikey',
  'req.body',
  'res.headers["set-cookie"]',
  'responseBody',
  'body',
];

/** Only these request headers may ever be serialised, and only their presence-safe values. */
const SAFE_REQUEST_HEADERS = ['content-type', 'user-agent'] as const;

interface SerialisedRequest {
  readonly headers: Record<string, string>;
  readonly method: string;
  readonly request_id: string;
  readonly route: string;
}

interface SerialisedReply {
  readonly status_code: number;
}

/**
 * Label applied to any request that did not match a registered route. Scanners and misdirected
 * provider callbacks reach 404 with paths of their own choosing, so the path itself is never
 * echoed into a log line.
 */
export const UNMATCHED_ROUTE_LABEL = 'unmatched';

/**
 * Route rather than URL: a raw URL carries query parameters, and Phase 7 web chat plus provider
 * callbacks put opaque tokens and identifiers there.
 *
 * A registered route resolves to Fastify's route template, which is source-controlled text and
 * therefore safe. Anything unmatched resolves to a fixed label. Falling back to the request pathname
 * would have logged attacker-supplied input verbatim -- a scan for
 * `/cus_.../private/path?token=...` would have written the customer identifier and the token's path
 * segment straight into the log, and 404 traffic is the one class of request whose path Avenlyo has
 * no reason to trust.
 */
export function normalizedRoute(request: FastifyRequest): string {
  const routed = request.routeOptions?.url;
  if (typeof routed === 'string' && routed.length > 0) return routed;
  return UNMATCHED_ROUTE_LABEL;
}

export function serializeRequestForLog(request: FastifyRequest): SerialisedRequest {
  const headers: Record<string, string> = {};
  for (const header of SAFE_REQUEST_HEADERS) {
    const value = request.headers[header];
    if (typeof value === 'string') headers[header] = value.slice(0, 120);
  }
  return {
    headers,
    method: request.method,
    request_id: String(request.id),
    route: normalizedRoute(request),
  };
}

export function serializeReplyForLog(reply: FastifyReply): SerialisedReply {
  return { status_code: reply.statusCode };
}

export interface LoggerOptionsInput {
  readonly environment: string;
  readonly release: string;
}

/** Matches Pino's serializer contract without adopting its loosely typed alias. */
type LogSerializer = (value: unknown) => unknown;

export interface LoggerOptions {
  readonly base: { readonly release: string; readonly service: string };
  readonly level: string;
  readonly redact: { readonly censor: string; readonly paths: string[] };
  readonly serializers: Record<string, LogSerializer>;
}

export function buildLoggerOptions(input: LoggerOptionsInput): LoggerOptions {
  return {
    base: { release: input.release, service: 'avenlyo-api' },
    // Structured JSON in production; Pino's default output is already newline-delimited JSON.
    level: input.environment === 'production' ? 'info' : 'debug',
    redact: { censor: '[redacted]', paths: [...REDACTED_LOG_PATHS] },
    serializers: {
      req: serializeRequestForLog as unknown as LogSerializer,
      res: serializeReplyForLog as unknown as LogSerializer,
    },
  };
}
