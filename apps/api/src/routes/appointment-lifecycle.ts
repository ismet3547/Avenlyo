import type { FastifyPluginCallback } from 'fastify';

import { env, isGoogleCalendarRuntimeConfigured } from '../env.js';
import { createServiceSupabaseClient } from '../lib/supabase.js';
import { AppointmentLifecycleService } from '../services/scheduling/appointment-lifecycle-service.js';
import { ApiSchedulingConnectorRegistry } from '../services/scheduling/connector-registry.js';
import { EzyVetIntegrationService } from '../services/scheduling/ezyvet-service.js';
import { GoogleCalendarIntegrationService } from '../services/scheduling/google-calendar-service.js';

function validUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function lifecycleService(): AppointmentLifecycleService | null {
  const supabase = createServiceSupabaseClient();
  if (!supabase) return null;
  const ezyVet = env.EZYVET_PARTNER_ID
    ? new EzyVetIntegrationService({ partnerId: env.EZYVET_PARTNER_ID, supabase })
    : undefined;
  const googleCalendar = isGoogleCalendarRuntimeConfigured && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI
    ? new GoogleCalendarIntegrationService({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, oauthRedirectUri: env.GOOGLE_OAUTH_REDIRECT_URI, supabase })
    : undefined;
  if (!ezyVet && !googleCalendar) return null;
  return new AppointmentLifecycleService({ connectors: new ApiSchedulingConnectorRegistry({ ...(ezyVet ? { ezyVet } : {}), ...(googleCalendar ? { googleCalendar } : {}) }), supabase });
}

interface StaffCancellationRpc {
  rpc(name: string, args: Readonly<Record<string, unknown>>): Promise<{
    readonly data: readonly { readonly change_intent_id: string }[] | null;
    readonly error: { readonly message: string } | null;
  }>;
}

function readBody(body: unknown): { readonly startsAt: string; readonly endsAt: string } | null {
  if (!Buffer.isBuffer(body)) return null;
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    return typeof row.startsAt === 'string' && typeof row.endsAt === 'string' && Number.isFinite(Date.parse(row.startsAt)) && Number.isFinite(Date.parse(row.endsAt))
      ? { startsAt: row.startsAt, endsAt: row.endsAt }
      : null;
  } catch { return null; }
}

/** Owner/admin cancellation is authenticated here, then executes through the durable lifecycle state machine. */
export const appointmentLifecycleRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.post('/v1/scheduling/appointments/:locationId/:appointmentId/cancel', { preHandler: app.authenticate }, async (request, reply) => {
    const { appointmentId, locationId } = request.params as { appointmentId?: string; locationId?: string };
    const service = lifecycleService();
    const supabase = createServiceSupabaseClient();
    if (!validUuid(locationId) || !validUuid(appointmentId)) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Appointment details are invalid.' });
    if (!service || !supabase || !request.authUser) return reply.code(503).send({ code: 'SCHEDULING_UNAVAILABLE', message: 'Scheduling is unavailable.' });
    try {
      const rpc = supabase as unknown as StaffCancellationRpc;
      const created = await rpc.rpc('create_staff_appointment_cancellation_intent', {
        target_appointment_id: appointmentId,
        target_location_id: locationId,
        target_user_id: request.authUser.id,
      });
      const intent = created.data?.[0]?.change_intent_id;
      if (created.error || !intent) return reply.code(403).send({ code: 'FORBIDDEN', message: 'This appointment cannot be cancelled.' });
      const result = await service.executeStaffCancellation(intent);
      return reply.code(result.outcome === 'completed' ? 200 : 409).send({ outcome: result.outcome });
    } catch {
      return reply.code(503).send({ code: 'SCHEDULING_UNAVAILABLE', message: 'The cancellation could not be completed safely.' });
    }
  });
  app.post('/v1/scheduling/appointments/:locationId/:appointmentId/reschedule', { preHandler: app.authenticate }, async (request, reply) => {
    const { appointmentId, locationId } = request.params as { appointmentId?: string; locationId?: string };
    const body = readBody(request.body);
    const service = lifecycleService();
    const supabase = createServiceSupabaseClient();
    if (!validUuid(locationId) || !validUuid(appointmentId) || !body || Date.parse(body.endsAt) <= Date.parse(body.startsAt)) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Reschedule details are invalid.' });
    if (!service || !supabase || !request.authUser) return reply.code(503).send({ code: 'SCHEDULING_UNAVAILABLE', message: 'Scheduling is unavailable.' });
    try {
      const rpc = supabase as unknown as StaffCancellationRpc;
      const created = await rpc.rpc('create_staff_appointment_reschedule_intent', {
        target_appointment_id: appointmentId, target_location_id: locationId, target_user_id: request.authUser.id,
        target_starts_at: body.startsAt, target_ends_at: body.endsAt,
      });
      const intent = created.data?.[0]?.change_intent_id;
      if (created.error || !intent) return reply.code(403).send({ code: 'FORBIDDEN', message: 'This appointment cannot be rescheduled.' });
      const result = await service.executeStaffReschedule(intent);
      return reply.code(result.outcome === 'completed' ? 200 : 409).send({ outcome: result.outcome });
    } catch {
      return reply.code(503).send({ code: 'SCHEDULING_UNAVAILABLE', message: 'The reschedule could not be completed safely.' });
    }
  });
  done();
};
