import { WORKSPACE_PROOF_HEADER, signWorkspaceProof } from '@avenlyo/shared/workspace-proof';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'workspace-proof-secret-value-for-tests-0001';
const USER = '00000000-0000-4000-8000-00000000000a';
const OTHER_USER = '00000000-0000-4000-8000-00000000000b';
const ORGANIZATION_A = '10000000-0000-4000-8000-000000000001';
const ORGANIZATION_B = '20000000-0000-4000-8000-000000000001';

/** Mutable so a single suite can exercise both a configured and an unconfigured deployment. */
const testEnv = {
  API_CORS_ORIGIN: 'http://localhost:3000',
  AVENLYO_INTERNAL_BILLING_SECRET: SECRET as string | undefined,
  STRIPE_PRICE_CORE_MONTHLY: 'price_core',
  STRIPE_PRODUCT_CORE: 'prod_core',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
};

vi.mock('../env.js', () => ({
  env: testEnv,
  expectedStripeLivemode: false,
  isStripeBillingConfigured: false,
}));

const rpc = vi.fn();
vi.mock('../lib/supabase.js', () => ({
  createApiSupabaseClient: () => null,
  createAuthenticatedApiSupabaseClient: () => ({ rpc }),
  createServiceSupabaseClient: () => null,
}));

// A type-only import is erased at runtime, so it does not defeat the module mocks above.
import type { StripeBillingRouteOptions } from './stripe-billing.js';

const { stripeBillingRoutes } = await import('./stripe-billing.js');
type BillingServiceStub = NonNullable<StripeBillingRouteOptions['service']>;

function proof(organizationId: string, userId = USER): string {
  const value = signWorkspaceProof(SECRET, {
    issuedAtSeconds: Math.floor(Date.now() / 1000),
    organizationId,
    userId,
  });
  if (!value) throw new Error('The fixture failed to sign.');
  return value;
}

function stripe() {
  return {
    createCheckout: vi.fn().mockResolvedValue({ action: 'checkout', url: 'https://stripe.test/c' }),
    createPortal: vi.fn().mockResolvedValue('https://stripe.test/p'),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

async function appWith(service: ReturnType<typeof stripe>, userId: string | null = USER) {
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.decorate('authenticate', (request: { authUser: unknown }) => {
    request.authUser = userId ? { id: userId } : null;
    return Promise.resolve();
  });
  await app.register(stripeBillingRoutes, { service: service as unknown as BillingServiceStub });
  await app.ready();
  return app;
}

const ROUTES = ['/v1/billing/checkout', '/v1/billing/portal', '/v1/billing/refresh'] as const;

function post(
  app: Awaited<ReturnType<typeof appWith>>,
  url: (typeof ROUTES)[number],
  input: { readonly organizationId: string; readonly proof?: string },
) {
  return app.inject({
    headers: {
      authorization: 'Bearer valid-user-token',
      'content-type': 'application/json',
      ...(input.proof ? { [WORKSPACE_PROOF_HEADER]: input.proof } : {}),
    },
    method: 'POST',
    payload: { organizationId: input.organizationId },
    url,
  });
}

function providerCallCount(service: ReturnType<typeof stripe>): number {
  return (
    service.createCheckout.mock.calls.length +
    service.createPortal.mock.calls.length +
    service.refresh.mock.calls.length
  );
}

beforeEach(() => {
  testEnv.AVENLYO_INTERNAL_BILLING_SECRET = SECRET;
  rpc.mockReset();
  rpc.mockImplementation((name: string) => {
    if (name === 'begin_my_billing_checkout') {
      return Promise.resolve({
        data: [{ action: 'create_checkout', checkout_id: 'chk_1' }],
        error: null,
      });
    }
    return Promise.resolve({ data: 'account-1', error: null });
  });
});

/**
 * The defect these cover is not an outsider guessing an organization identifier. It is the same
 * authorized user, holding a valid token, administering both organizations, calling the API
 * directly with the one they are not selected into. Membership cannot tell those apart; only the
 * proof minted where the selection was resolved can.
 */
describe('billing mutations are bound to the selected workspace', () => {
  it('accepts a request whose organization arrives under a matching proof', async () => {
    const service = stripe();
    const app = await appWith(service);

    const response = await post(app, '/v1/billing/checkout', {
      organizationId: ORGANIZATION_A,
      proof: proof(ORGANIZATION_A),
    });

    expect(response.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledWith('begin_my_billing_checkout', {
      target_organization_id: ORGANIZATION_A,
      target_plan_key: 'core',
    });
    expect(service.createCheckout).toHaveBeenCalledWith('chk_1');
    await app.close();
  });

  it('acts on whichever workspace was actually selected', async () => {
    const service = stripe();
    const app = await appWith(service);

    await post(app, '/v1/billing/checkout', {
      organizationId: ORGANIZATION_B,
      proof: proof(ORGANIZATION_B),
    });

    expect(rpc).toHaveBeenCalledWith('begin_my_billing_checkout', {
      target_organization_id: ORGANIZATION_B,
      target_plan_key: 'core',
    });
    await app.close();
  });

  it('refuses a direct call that carries no proof at all', async () => {
    for (const url of ROUTES) {
      const service = stripe();
      const app = await appWith(service);

      const response = await post(app, url, { organizationId: ORGANIZATION_A });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: 'BILLING_WORKSPACE_UNVERIFIED' });
      expect(rpc).not.toHaveBeenCalled();
      expect(providerCallCount(service)).toBe(0);
      await app.close();
    }
  });

  it('refuses the other organization even though the caller administers it too', async () => {
    for (const url of ROUTES) {
      const service = stripe();
      const app = await appWith(service);

      const response = await post(app, url, {
        organizationId: ORGANIZATION_B,
        proof: proof(ORGANIZATION_A),
      });

      expect(response.statusCode).toBe(403);
      // Nothing reaches the database, so no checkout row can exist for B, and nothing reaches
      // Stripe.
      expect(rpc).not.toHaveBeenCalled();
      expect(providerCallCount(service)).toBe(0);
      await app.close();
    }
  });

  it('refuses a proof minted for a different user', async () => {
    const service = stripe();
    const app = await appWith(service);

    const response = await post(app, '/v1/billing/checkout', {
      organizationId: ORGANIZATION_A,
      proof: proof(ORGANIZATION_A, OTHER_USER),
    });

    expect(response.statusCode).toBe(403);
    expect(providerCallCount(service)).toBe(0);
    await app.close();
  });

  it('refuses a tampered or malformed proof', async () => {
    for (const value of ['', 'v1.0.0', `v1.${Math.floor(Date.now() / 1000)}.${'f'.repeat(64)}`]) {
      const service = stripe();
      const app = await appWith(service);

      const response = await post(app, '/v1/billing/portal', {
        organizationId: ORGANIZATION_A,
        proof: value,
      });

      expect(response.statusCode).toBe(403);
      expect(providerCallCount(service)).toBe(0);
      await app.close();
    }
  });

  it('fails closed when the deployment has no server-only secret', async () => {
    testEnv.AVENLYO_INTERNAL_BILLING_SECRET = undefined;
    for (const url of ROUTES) {
      const service = stripe();
      const app = await appWith(service);

      const response = await post(app, url, {
        organizationId: ORGANIZATION_A,
        proof: proof(ORGANIZATION_A),
      });

      expect(response.statusCode).toBe(403);
      expect(rpc).not.toHaveBeenCalled();
      expect(providerCallCount(service)).toBe(0);
      await app.close();
    }
  });

  it('rejects a body with no organization before anything else happens', async () => {
    const service = stripe();
    const app = await appWith(service);

    const response = await app.inject({
      headers: { authorization: 'Bearer valid-user-token', 'content-type': 'application/json' },
      method: 'POST',
      payload: {},
      url: '/v1/billing/checkout',
    });

    expect(response.statusCode).toBe(400);
    expect(providerCallCount(service)).toBe(0);
    await app.close();
  });
});

describe('the proof narrows scope and never widens authority', () => {
  it('still defers to the database owner or admin check', async () => {
    // A perfectly valid proof for the selected organization. The database says no anyway, because
    // the caller is a member or an outsider there, and that answer is the one that counts.
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'Organization owner or admin access is required' },
    });
    for (const url of ROUTES) {
      const service = stripe();
      const app = await appWith(service);

      const response = await post(app, url, {
        organizationId: ORGANIZATION_A,
        proof: proof(ORGANIZATION_A),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: 'BILLING_FORBIDDEN' });
      expect(providerCallCount(service)).toBe(0);
      await app.close();
    }
  });

  it('still requires an authenticated caller', async () => {
    const service = stripe();
    const app = await appWith(service, null);

    const response = await post(app, '/v1/billing/checkout', {
      organizationId: ORGANIZATION_A,
      proof: proof(ORGANIZATION_A),
    });

    expect(response.statusCode).toBe(503);
    expect(providerCallCount(service)).toBe(0);
    await app.close();
  });
});

describe('the secret never leaves the server', () => {
  it('appears in no response body on any outcome', async () => {
    const service = stripe();
    const app = await appWith(service);
    const bodies: string[] = [];

    bodies.push((await post(app, '/v1/billing/checkout', { organizationId: ORGANIZATION_A })).body);
    bodies.push(
      (
        await post(app, '/v1/billing/portal', {
          organizationId: ORGANIZATION_B,
          proof: proof(ORGANIZATION_A),
        })
      ).body,
    );
    bodies.push(
      (
        await post(app, '/v1/billing/refresh', {
          organizationId: ORGANIZATION_A,
          proof: proof(ORGANIZATION_A),
        })
      ).body,
    );

    for (const body of bodies) {
      expect(body).not.toContain(SECRET);
      expect(body.toLowerCase()).not.toContain('secret');
    }
    await app.close();
  });
});
