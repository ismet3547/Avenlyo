import type { FastifyRequest } from 'fastify';

import { clientRateKey } from './client-identity.js';

/**
 * Edge abuse controls: a cheap shield in front of the durable limits, not a replacement for them.
 *
 * ## What this layer is, and is not
 *
 * Every counter here lives in this process's memory. It is therefore per-replica: run two API
 * containers and a client gets two allowances. That is a deliberate accepted limitation, not an
 * oversight -- the job of this layer is to make a flood cheap to refuse before it reaches Postgres,
 * an AI provider, or a payment provider. Anything that must be exactly enforced stays in the
 * database, where Phase 7's `consume_messaging_rate_limit` already holds the authoritative web-chat
 * session and message quotas and will keep holding them.
 *
 * So the two layers answer different questions. The edge asks "is this client generating more load
 * than any legitimate browser would" and answers in microseconds. The database asks "has this
 * client exceeded its actual entitlement" and answers correctly across every replica. A 429 from
 * either is the same to the caller.
 *
 * Redis would make this layer global. It is deliberately deferred: it is a new stateful runtime
 * dependency for a staging deployment that currently runs one API container, and the durable layer
 * already provides the correctness this one only approximates.
 */

/** A named policy, so a limiter log line can say which rule fired without echoing a threshold. */
export interface EdgePolicy {
  readonly max: number;
  readonly name: string;
  readonly timeWindowMs: number;
}

const MINUTE = 60_000;

/**
 * Route classes, most permissive first in intent rather than in order.
 *
 * The numbers are chosen against what the product actually does, not picked round. Web chat's
 * durable quotas are 10 sessions and 30 messages per minute; the edge sits a little above each so
 * that a legitimate client meets the authoritative limit and its precise accounting, while a flood
 * is dropped here long before it becomes database work.
 */
export const EDGE_POLICIES = {
  /**
   * Ordinary authenticated dashboard traffic. Deliberately generous: a bulk operation or a busy
   * Inbox session issues a lot of legitimate requests, and breaking those would be a worse outcome
   * than the abuse this bounds.
   */
  authenticated: { max: 600, name: 'authenticated', timeWindowMs: MINUTE },
  /** Everything without a more specific rule. */
  global: { max: 300, name: 'global', timeWindowMs: MINUTE },
  /**
   * Web-chat polling. The widget polls a few times a minute; 120 leaves an order of magnitude of
   * headroom while still bounding how much database work one browser can demand.
   */
  webChatPoll: { max: 120, name: 'web-chat-poll', timeWindowMs: MINUTE },
  /** Web-chat session creation. Durable quota is 10/minute; this refuses the flood above it. */
  webChatSession: { max: 20, name: 'web-chat-session', timeWindowMs: MINUTE },
  /** Web-chat message submission. Durable quota is 30/minute. */
  webChatMessage: { max: 60, name: 'web-chat-message', timeWindowMs: MINUTE },
} as const satisfies Record<string, EdgePolicy>;

/**
 * Routes that are never counted by the ordinary per-client limiter.
 *
 * Two different reasons, both deliberate:
 *
 * - Health and readiness. An infrastructure probe must never be told 429; Docker's healthcheck
 *   treats a non-200 as a dead container, so letting public abuse traffic consume a shared health
 *   allowance would let an outsider convince the orchestrator to restart a perfectly healthy
 *   process. That is a denial-of-service delivered through the limiter itself.
 *
 * - Provider webhooks. Twilio, Stripe and OpenAI legitimately burst from a small pool of their own
 *   addresses -- a delivery-status storm after a campaign, or a retry wave after an outage, arrives
 *   as exactly the shape a naive per-IP quota is designed to reject. Dropping those is not a
 *   defence, it is data loss with retry amplification behind it. These routes are already protected
 *   by something strictly better than an IP guess: a mandatory signature check, which this phase
 *   does not touch, plus a body limit that bounds the work an unsigned request can cause. An
 *   attacker who cannot forge a signature gains nothing by flooding them beyond the cost of the
 *   signature check itself.
 */
export const UNMETERED_ROUTES: readonly string[] = [
  '/health',
  '/health/live',
  '/health/ready',
  '/webhooks/stripe',
  '/webhooks/openai/realtime',
  '/v1/webhooks/twilio/messaging/inbound',
  '/v1/webhooks/twilio/messaging/status',
];

export function isUnmeteredRoute(routeUrl: string | undefined): boolean {
  return typeof routeUrl === 'string' && UNMETERED_ROUTES.includes(routeUrl);
}

/**
 * Request-size ceilings, in bytes.
 *
 * Fastify's undocumented default is 1 MiB for every route. Relying on it means the size policy is
 * whatever the framework happens to ship, and a 1 MiB body is far more than any of these routes can
 * legitimately carry. Each ceiling below is set from the actual contract:
 *
 * - `webChatMessage`: the message contract is 2,000 characters. 16 KiB covers that in any encoding
 *   plus the envelope, with room to spare.
 * - `webChatSession`: a single UUID.
 * - `twilioForm`: an inbound MMS form carries up to 2,000 characters of body plus media metadata
 *   for up to ten attachments and Twilio's own field set. 64 KiB is comfortably above a real one
 *   and far below anything that could be used as a memory lever.
 * - `global`: everything else, including authenticated JSON.
 *
 * Stripe (128 KiB) and OpenAI (64 KiB) already set their own and are left exactly as they are --
 * those were chosen against provider payload sizes and lowering them risks rejecting a valid event.
 */
export const BODY_LIMITS = {
  global: 256 * 1024,
  twilioForm: 64 * 1024,
  webChatMessage: 16 * 1024,
  webChatSession: 4 * 1024,
} as const;

/** The 429 body. Bounded, fixed shape, and carrying no identifier the caller did not already have. */
export function tooManyRequestsBody(request: FastifyRequest): {
  readonly code: 'RATE_LIMITED';
  readonly request_id: string;
  readonly statusCode: 429;
} {
  return { code: 'RATE_LIMITED', request_id: String(request.id), statusCode: 429 };
}

/**
 * Key builder shared by every policy.
 *
 * Scoped by policy name so a client that has exhausted its polling allowance can still create a
 * session, and hashed so neither the limiter's store nor any log line holds an address.
 */
export function edgeKey(policy: EdgePolicy, request: FastifyRequest): string {
  return clientRateKey(request, policy.name);
}

/** Seconds a caller should wait, for `Retry-After`. Always at least one. */
export function retryAfterSeconds(policy: EdgePolicy): number {
  return Math.max(1, Math.ceil(policy.timeWindowMs / 1000));
}

/**
 * The one log line a refused request produces.
 *
 * Bounded, source-controlled fields only: the policy name and route are literals from this file and
 * Fastify's route table, and the client is represented by the same hash the limiter keys on, never
 * by an address. Logged at `warn` rather than as an error -- a refused flood is the system working,
 * and turning expected 429s into stack traces buries real failures.
 */
export function logRateLimited(
  request: FastifyRequest,
  policy: EdgePolicy,
  routeLabel: string,
): void {
  request.log.warn(
    {
      component: 'edge_rate_limit',
      limiter_policy: policy.name,
      method: request.method,
      operation: 'reject',
      outcome: 'rate_limited',
      request_id: String(request.id),
      route: routeLabel,
      // A truncated digest of the same hashed key the limiter counts on: enough to recognise one
      // client across several refusals, never enough to recover the address it came from.
      scope_digest: edgeKey(policy, request).slice(0, 16),
      status_code: 429,
    },
    'Request refused by edge rate limit.',
  );
}
