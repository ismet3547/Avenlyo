import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAppointmentLifecycleRoutes,
  type AppointmentLifecycleRouteDependencies,
} from './appointment-lifecycle.js';

const locationId = '11111111-1111-4111-8111-111111111111';
const appointmentId = '22222222-2222-4222-8222-222222222222';

async function createApp(options?: {
  readonly lifecycleOutcome?: 'completed' | 'handoff_required';
  readonly rpcError?: boolean;
  readonly rpcErrorMessage?: string;
}) {
  const rpc = vi.fn().mockResolvedValue({
    data: options?.rpcError ? null : [{ change_intent_id: '33333333-3333-4333-8333-333333333333' }],
    error: options?.rpcError ? { message: options.rpcErrorMessage ?? 'forbidden' } : null,
  });
  const lifecycle = {
    executeStaffCancellation: vi.fn().mockResolvedValue({ outcome: 'completed' }),
    executeStaffReschedule: vi
      .fn()
      .mockResolvedValue({ outcome: options?.lifecycleOutcome ?? 'completed' }),
  };
  const dependencies: AppointmentLifecycleRouteDependencies = {
    createLifecycleService: () => lifecycle,
    createServiceSupabaseClient: () => ({ rpc }),
  };
  const app = Fastify();
  app.decorateRequest('authUser', null);
  app.decorate('authenticate', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer valid-token') {
      await reply.code(401).send({ code: 'UNAUTHORIZED' });
      return;
    }
    request.authUser = { id: '44444444-4444-4444-8444-444444444444' } as never;
  });
  await app.register(createAppointmentLifecycleRoutes(dependencies));
  return { app, lifecycle, rpc };
}

describe('appointment lifecycle staff routes', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('accepts a strict parsed JSON reschedule body and creates the durable staff intent', async () => {
    const { app, lifecycle, rpc } = await createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      method: 'POST',
      payload: { endsAt: '2026-09-01T10:30:00Z', startsAt: '2026-09-01T10:00:00Z' },
      url: `/v1/scheduling/appointments/${locationId}/${appointmentId}/reschedule`,
    });
    expect(response.statusCode).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      'create_staff_appointment_reschedule_intent',
      expect.objectContaining({
        target_ends_at: '2026-09-01T10:30:00Z',
        target_starts_at: '2026-09-01T10:00:00Z',
      }),
    );
    expect(lifecycle.executeStaffReschedule).toHaveBeenCalledWith(
      '33333333-3333-4333-8333-333333333333',
    );
  });

  it.each([
    { payload: { startsAt: 'not-an-instant' }, title: 'malformed body' },
    {
      payload: { endsAt: '2026-09-01T10:30:00Z', extra: true, startsAt: '2026-09-01T10:00:00Z' },
      title: 'extra field',
    },
    {
      payload: { endsAt: '2026-09-01T10:00:00Z', startsAt: '2026-09-01T10:00:00Z' },
      title: 'non-positive range',
    },
  ])('rejects $title before an intent is created', async ({ payload }) => {
    const { app, rpc } = await createApp();
    apps.push(app);
    const response = await app.inject({
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      method: 'POST',
      payload,
      url: `/v1/scheduling/appointments/${locationId}/${appointmentId}/reschedule`,
    });
    expect(response.statusCode).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers and a cross-location staff mutation', async () => {
    const unauthenticated = await createApp();
    apps.push(unauthenticated.app);
    const unauthenticatedResponse = await unauthenticated.app.inject({
      method: 'POST',
      payload: { endsAt: '2026-09-01T10:30:00Z', startsAt: '2026-09-01T10:00:00Z' },
      url: `/v1/scheduling/appointments/${locationId}/${appointmentId}/reschedule`,
    });
    expect(unauthenticatedResponse.statusCode).toBe(401);

    const crossLocation = await createApp({ rpcError: true });
    apps.push(crossLocation.app);
    const denied = await crossLocation.app.inject({
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      method: 'POST',
      payload: { endsAt: '2026-09-01T10:30:00Z', startsAt: '2026-09-01T10:00:00Z' },
      url: `/v1/scheduling/appointments/${locationId}/${appointmentId}/reschedule`,
    });
    expect(denied.statusCode).toBe(403);
    expect(crossLocation.lifecycle.executeStaffReschedule).not.toHaveBeenCalled();
  });

  it('returns a safe unsupported outcome before an ezyVet staff reschedule intent is executed', async () => {
    const { app, lifecycle, rpc } = await createApp({
      rpcError: true,
      rpcErrorMessage: 'Provider reschedule is unsupported',
    });
    apps.push(app);

    const response = await app.inject({
      headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
      method: 'POST',
      payload: { endsAt: '2026-09-01T10:30:00Z', startsAt: '2026-09-01T10:00:00Z' },
      url: `/v1/scheduling/appointments/${locationId}/${appointmentId}/reschedule`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ outcome: 'handoff_required' });
    expect(rpc).toHaveBeenCalledOnce();
    expect(lifecycle.executeStaffReschedule).not.toHaveBeenCalled();
  });
});
