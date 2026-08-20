import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';

import { env, release } from './env.js';
import { buildLoggerOptions, normalizedRoute } from './observability/logging.js';
import type { DatabaseProbeResult } from './observability/readiness.js';
import type { RuntimeState } from './observability/runtime-state.js';
import { authPlugin } from './plugins/auth.js';
import { routes } from './routes/index.js';
import type { BillingService } from './services/billing/billing-service.js';

export interface BuildAppInput {
  readonly billingService?: BillingService | null;
  /** Test seam: supplying a destination turns the real production logger on so it can be asserted. */
  readonly loggerDestination?: { write(chunk: string): void };
  readonly probeDatabase?: () => Promise<DatabaseProbeResult>;
  readonly runtimeState?: RuntimeState;
}

export function buildApp(input: BuildAppInput = {}) {
  const app = Fastify({
    // Correlation identity is always server generated. A client-supplied identifier is never
    // adopted as the internal one, so an untrusted caller cannot forge or collide correlation.
    genReqId: () => randomUUID(),
    logger: input.loggerDestination
      ? {
          ...buildLoggerOptions({ environment: env.NODE_ENV, release }),
          stream: input.loggerDestination,
        }
      : env.NODE_ENV !== 'test' && buildLoggerOptions({ environment: env.NODE_ENV, release }),
  });

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('X-Request-Id', String(request.id));
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

  void app.register(formbody);

  void app.register(cors, {
    origin: env.API_CORS_ORIGIN,
  });
  void app.register(authPlugin);
  void app.register(routes, {
    ...(input.billingService !== undefined ? { billingService: input.billingService } : {}),
    ...(input.probeDatabase ? { probeDatabase: input.probeDatabase } : {}),
    ...(input.runtimeState ? { runtimeState: input.runtimeState } : {}),
  });

  return app;
}
