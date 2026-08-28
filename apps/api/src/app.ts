import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { env, release } from './env.js';
import type { CapabilityReport } from './observability/capabilities.js';
import { buildLoggerOptions, normalizedRoute } from './observability/logging.js';
import type { DatabaseProbeResult } from './observability/readiness.js';
import type { RuntimeState } from './observability/runtime-state.js';
import { authPlugin } from './plugins/auth.js';
import { routes } from './routes/index.js';
import { trustInternalProxy } from './security/client-identity.js';
import {
  BODY_LIMITS,
  EDGE_POLICIES,
  edgeKey,
  isUnmeteredRoute,
  logRateLimited,
  tooManyRequestsBody,
} from './security/edge-policy.js';
import { buildHelmetOptions, PERMISSIONS_POLICY } from './security/headers.js';
import type { BillingService } from './services/billing/billing-service.js';

export interface BuildAppInput {
  readonly billingService?: BillingService | null;
  /** Readiness dependency seams. Production passes nothing, so the process defaults apply. */
  readonly capabilities?: CapabilityReport;
  /** Test seam: supplying a destination turns the real production logger on so it can be asserted. */
  readonly loggerDestination?: { write(chunk: string): void };
  readonly probeDatabase?: () => Promise<DatabaseProbeResult>;
  readonly requiredSchemaVersion?: number;
  readonly runtimeState?: RuntimeState;
}

export function buildApp(input: BuildAppInput = {}) {
  const app = Fastify({
    // Every route's ceiling unless it sets its own, replacing Fastify's undocumented 1 MiB default
    // with a number this repository chose. See BODY_LIMITS for why each one is what it is.
    bodyLimit: BODY_LIMITS.global,
    // Correlation identity is always server generated. A client-supplied identifier is never
    // adopted as the internal one, so an untrusted caller cannot forge or collide correlation.
    genReqId: () => randomUUID(),
    logger: input.loggerDestination
      ? {
          ...buildLoggerOptions({ environment: env.NODE_ENV, release }),
          stream: input.loggerDestination,
        }
      : env.NODE_ENV !== 'test' && buildLoggerOptions({ environment: env.NODE_ENV, release }),
    // Not `true`, which would let any caller name its own client address. A forwarding header is
    // honoured only when the peer that sent it is on an internal address, which in this topology
    // means Caddy inside the compose network -- and `deploy/compose.yaml` publishes no host port
    // for this service, so a public client can never be that peer. See ./security/client-identity.
    trustProxy: trustInternalProxy,
  });

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('X-Request-Id', String(request.id));
    void reply.header('Permissions-Policy', PERMISSIONS_POLICY);
  });

  // One structured completion line per request. Route, not URL: query strings carry web-chat
  // tokens and provider identifiers.
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        component: 'http',
        duration_ms: Math.round(reply.elapsedTime),
        method: request.method,
        operation: 'request',
        outcome: reply.statusCode < 500 ? 'completed' : 'failed',
        request_id: String(request.id),
        route: normalizedRoute(request),
        status_code: reply.statusCode,
      },
      'Request completed.',
    );
  });

  // Fastify own not-found handler logs "Route GET:/<raw url> not found" at info level, raw
  // query string included. That is the one request class whose path is chosen by whoever sent
  // it, so the default is replaced with one that answers 404 without repeating the path.
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send({ error: 'Not Found', request_id: String(request.id), statusCode: 404 });
  });

  void app.register(formbody);

  void app.register(helmet, buildHelmetOptions({ isProduction: env.NODE_ENV === 'production' }));

  // The global edge shield. Per-route policies below override `max`/`timeWindow` where the traffic
  // shape differs; health and provider webhooks opt out entirely, for the reasons in edge-policy.
  void app.register(rateLimit, {
    allowList: (request) => isUnmeteredRoute(request.routeOptions?.url),
    // Hashed and policy-scoped, so the limiter's own store never holds a client address.
    keyGenerator: (request) => edgeKey(EDGE_POLICIES.global, request),
    max: EDGE_POLICIES.global.max,
    timeWindow: EDGE_POLICIES.global.timeWindowMs,
    // X-Request-Id is already set by the onRequest hook above and survives this path, so a refused
    // caller can still be correlated with the single warn line the limiter writes. The plugin adds
    // Retry-After itself on every 429.
    errorResponseBuilder: (request) => tooManyRequestsBody(request),
    onExceeded: (request) => {
      logRateLimited(request, EDGE_POLICIES.global, normalizedRoute(request));
    },
  });

  void app.register(cors, {
    origin: env.API_CORS_ORIGIN,
  });
  void app.register(authPlugin);
  void app.register(routes, {
    ...(input.billingService !== undefined ? { billingService: input.billingService } : {}),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    ...(input.probeDatabase ? { probeDatabase: input.probeDatabase } : {}),
    ...(input.requiredSchemaVersion !== undefined
      ? { requiredSchemaVersion: input.requiredSchemaVersion }
      : {}),
    ...(input.runtimeState ? { runtimeState: input.runtimeState } : {}),
  });

  return app;
}
