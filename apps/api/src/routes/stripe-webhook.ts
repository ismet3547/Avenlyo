import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { createBillingRuntime } from '../services/billing/runtime.js';
import type { BillingService } from '../services/billing/billing-service.js';
import type { StripeWebhookEventRecord } from '../services/billing/types.js';

function rawRequestBody(request: FastifyRequest): string | null {
  return Buffer.isBuffer(request.body) ? request.body.toString('utf8') : null;
}

export interface StripeWebhookRouteOptions {
  readonly service?: BillingService | null;
}

/** Public raw-body boundary. Stripe's signature is verified before event JSON is trusted or stored. */
export const stripeWebhookRoutes: FastifyPluginAsync<StripeWebhookRouteOptions> = (
  app,
  options,
) => {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  const service = options.service ?? createBillingRuntime()?.service ?? null;
  app.post('/webhooks/stripe', { bodyLimit: 128 * 1024 }, async (request, reply) => {
    if (!service) return reply.code(503).send({ code: 'BILLING_UNAVAILABLE' });
    const signature = request.headers['stripe-signature'];
    const rawBody = rawRequestBody(request);
    if (!rawBody || typeof signature !== 'string' || !signature.trim()) {
      return reply.code(400).send({ code: 'INVALID_STRIPE_SIGNATURE' });
    }
    let event: StripeWebhookEventRecord;
    try {
      event = service.verifyWebhook(rawBody, signature);
      if (!service.isExpectedMode(event)) {
        return reply.code(400).send({ code: 'STRIPE_MODE_MISMATCH' });
      }
    } catch {
      return reply.code(400).send({ code: 'INVALID_STRIPE_SIGNATURE' });
    }
    try {
      await service.persistVerifiedWebhook(event);
      return reply.code(204).send();
    } catch {
      // Stripe must retry a correctly signed event if the durable ledger is unavailable.
      return reply.code(500).send({ code: 'STRIPE_EVENT_PERSISTENCE_FAILED' });
    }
  });
  return Promise.resolve();
};
