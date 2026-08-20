import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createAuthenticatedApiSupabaseClient } from '../lib/supabase.js';
import { createBillingRuntime } from '../services/billing/runtime.js';
import type { BillingService } from '../services/billing/billing-service.js';

interface AuthenticatedBillingRpc {
  begin_my_billing_checkout: {
    Args: { target_organization_id: string; target_plan_key?: 'core' };
    Returns: readonly {
      action: 'create_checkout' | 'manage_existing_subscription';
      checkout_id: string | null;
    }[];
  };
  begin_my_billing_portal: { Args: { target_organization_id: string }; Returns: string };
  begin_my_billing_refresh: { Args: { target_organization_id: string }; Returns: string };
}

type AuthenticatedBillingClient = {
  rpc<Name extends keyof AuthenticatedBillingRpc>(
    name: Name,
    args: AuthenticatedBillingRpc[Name]['Args'],
  ): Promise<{
    data: AuthenticatedBillingRpc[Name]['Returns'] | null;
    error: { message: string } | null;
  }>;
};

/**
 * The organization a billing action applies to.
 *
 * Phase 15 made multi-organization membership legitimate, so the caller has to say which
 * workspace they are acting in. This identifier is a routing input, never an authorization: the
 * web action derives it from the trusted server-side workspace resolver rather than from a form
 * field, and the database independently proves owner/admin authority on it for the calling user
 * before touching a single billing row. Supplying another organization's identifier therefore
 * fails at the database boundary rather than here.
 */
const billingTarget = z.object({ organizationId: z.string().uuid() }).strict();

function accessToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
}

function authenticatedBillingClient(request: FastifyRequest): AuthenticatedBillingClient | null {
  const token = accessToken(request);
  const client = token ? createAuthenticatedApiSupabaseClient(token) : null;
  return client as unknown as AuthenticatedBillingClient | null;
}

function billingUnavailable(reply: FastifyReply) {
  return reply.code(503).send({ code: 'BILLING_UNAVAILABLE', message: 'Billing is unavailable.' });
}

export interface StripeBillingRouteOptions {
  readonly service?: BillingService | null;
}

/** Owner/admin actions accept no provider IDs, price IDs, or return URLs from browser input. */
export const stripeBillingRoutes: FastifyPluginAsync<StripeBillingRouteOptions> = (
  app,
  options,
) => {
  const service = options.service ?? createBillingRuntime()?.service ?? null;

  app.post('/v1/billing/checkout', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.authUser || !service) return billingUnavailable(reply);
    const target = billingTarget.safeParse(request.body);
    if (!target.success) return reply.code(400).send({ code: 'BILLING_TARGET_REQUIRED' });
    const supabase = authenticatedBillingClient(request);
    if (!supabase) return billingUnavailable(reply);
    const started = await supabase.rpc('begin_my_billing_checkout', {
      target_organization_id: target.data.organizationId,
      target_plan_key: 'core',
    });
    const result = started.data?.[0];
    if (started.error || !result) return reply.code(403).send({ code: 'BILLING_FORBIDDEN' });
    if (result.action === 'manage_existing_subscription') {
      return reply.send({ action: 'manage_existing_subscription' });
    }
    if (!result.checkout_id) return billingUnavailable(reply);
    try {
      return reply.send(await service.createCheckout(result.checkout_id));
    } catch {
      return billingUnavailable(reply);
    }
  });

  app.post('/v1/billing/portal', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.authUser || !service) return billingUnavailable(reply);
    const target = billingTarget.safeParse(request.body);
    if (!target.success) return reply.code(400).send({ code: 'BILLING_TARGET_REQUIRED' });
    const supabase = authenticatedBillingClient(request);
    if (!supabase) return billingUnavailable(reply);
    const started = await supabase.rpc('begin_my_billing_portal', {
      target_organization_id: target.data.organizationId,
    });
    if (started.error || !started.data) return reply.code(403).send({ code: 'BILLING_FORBIDDEN' });
    try {
      return reply.send({ url: await service.createPortal(started.data) });
    } catch {
      return billingUnavailable(reply);
    }
  });

  app.post('/v1/billing/refresh', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.authUser || !service) return billingUnavailable(reply);
    const target = billingTarget.safeParse(request.body);
    if (!target.success) return reply.code(400).send({ code: 'BILLING_TARGET_REQUIRED' });
    const supabase = authenticatedBillingClient(request);
    if (!supabase) return billingUnavailable(reply);
    const started = await supabase.rpc('begin_my_billing_refresh', {
      target_organization_id: target.data.organizationId,
    });
    if (started.error || !started.data) return reply.code(403).send({ code: 'BILLING_FORBIDDEN' });
    try {
      await service.refresh(started.data);
      return reply.code(204).send();
    } catch {
      return billingUnavailable(reply);
    }
  });
  return Promise.resolve();
};
