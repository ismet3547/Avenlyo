import { WORKSPACE_PROOF_HEADER, verifyWorkspaceProof } from '@avenlyo/shared/workspace-proof';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { env } from '../env.js';
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

/**
 * Resolves which organization this billing mutation may act on.
 *
 * A bearer token proves who is calling. It does not prove which workspace they are operating in,
 * and membership cannot supply that either: a user who legitimately administers both A and B is an
 * authorized admin of B no matter which one they are selected into. Accepting an organization from
 * the request body and checking only membership therefore let the same browser act on B while
 * selected into A — the selected workspace is operational scope, not a UI preference.
 *
 * So the organization must arrive with a proof minted by the Next.js server, where the stored
 * selection is resolved and revalidated against what the database says this user may reach right
 * now. The proof is verified against the user identity taken from the verified token rather than
 * anything in the body, which is what stops a proof for one organization being reused for another.
 *
 * Everything after this is unchanged: the caller's own token still travels to the database, and
 * the database still proves owner or admin authority for itself. A valid proof narrows what may be
 * acted on; it never widens who may act.
 */
function resolveBillingTarget(
  request: FastifyRequest,
  reply: FastifyReply,
): { readonly organizationId: string } | null {
  const parsed = billingTarget.safeParse(request.body);
  if (!parsed.success) {
    void reply.code(400).send({ code: 'BILLING_TARGET_REQUIRED' });
    return null;
  }
  const header = request.headers[WORKSPACE_PROOF_HEADER];
  const trusted = verifyWorkspaceProof({
    nowSeconds: Math.floor(Date.now() / 1000),
    organizationId: parsed.data.organizationId,
    proof: typeof header === 'string' ? header : null,
    secret: env.AVENLYO_INTERNAL_BILLING_SECRET,
    userId: request.authUser?.id ?? '',
  });
  if (!trusted) {
    // One fixed code for a missing secret, a missing proof, an expired proof, and a proof for a
    // different organization or user. Distinguishing them would tell a caller which half of the
    // boundary to attack, and none of the four is a state a legitimate browser can reach.
    void reply.code(403).send({ code: 'BILLING_WORKSPACE_UNVERIFIED' });
    return null;
  }
  return { organizationId: parsed.data.organizationId };
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
    const target = resolveBillingTarget(request, reply);
    if (!target) return reply;
    const supabase = authenticatedBillingClient(request);
    if (!supabase) return billingUnavailable(reply);
    const started = await supabase.rpc('begin_my_billing_checkout', {
      target_organization_id: target.organizationId,
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
    const target = resolveBillingTarget(request, reply);
    if (!target) return reply;
    const supabase = authenticatedBillingClient(request);
    if (!supabase) return billingUnavailable(reply);
    const started = await supabase.rpc('begin_my_billing_portal', {
      target_organization_id: target.organizationId,
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
    const target = resolveBillingTarget(request, reply);
    if (!target) return reply;
    const supabase = authenticatedBillingClient(request);
    if (!supabase) return billingUnavailable(reply);
    const started = await supabase.rpc('begin_my_billing_refresh', {
      target_organization_id: target.organizationId,
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
