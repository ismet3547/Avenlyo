import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';

import { env } from './env.js';
import { authPlugin } from './plugins/auth.js';
import { routes } from './routes/index.js';
import type { BillingService } from './services/billing/billing-service.js';

export function buildApp(input: { readonly billingService?: BillingService | null } = {}) {
  const app = Fastify({
    logger: env.NODE_ENV !== 'test',
  });

  void app.register(formbody);

  void app.register(cors, {
    origin: env.API_CORS_ORIGIN,
  });
  void app.register(authPlugin);
  void app.register(
    routes,
    input.billingService !== undefined ? { billingService: input.billingService } : {},
  );

  return app;
}
