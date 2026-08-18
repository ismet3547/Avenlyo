import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';

import { env, isGoogleCalendarRuntimeConfigured } from '../env.js';
import { createServiceSupabaseClient } from '../lib/supabase.js';
import { AppointmentLifecycleService } from '../services/scheduling/appointment-lifecycle-service.js';
import { ApiSchedulingConnectorRegistry } from '../services/scheduling/connector-registry.js';
import { EzyVetIntegrationService } from '../services/scheduling/ezyvet-service.js';
import { GoogleCalendarIntegrationService } from '../services/scheduling/google-calendar-service.js';

function validUuid(value: string | undefined): value is string {
  return Boolean(
    value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  );
}

function defaultLifecycleService(): AppointmentLifecycleService | null {
  const supabase = createServiceSupabaseClient();
  if (!supabase) return null;
  const ezyVet = env.EZYVET_PARTNER_ID
    ? new EzyVetIntegrationService({ partnerId: env.EZYVET_PARTNER_ID, supabase })
    : undefined;
  const googleCalendar =
    isGoogleCalendarRuntimeConfigured &&
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET &&
    env.GOOGLE_OAUTH_REDIRECT_URI
      ? new GoogleCalendarIntegrationService({
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          oauthRedirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
          supabase,
        })
      : undefined;
  if (!ezyVet && !googleCalendar) return null;
  return new AppointmentLifecycleService({
    connectors: new ApiSchedulingConnectorRegistry({
      ...(ezyVet ? { ezyVet } : {}),
      ...(googleCalendar ? { googleCalendar } : {}),
    }),
    supabase,
  });
}

interface StaffCancellationRpc {
  rpc(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<{
    readonly data: readonly { readonly change_intent_id: string }[] | null;
    readonly error: { readonly code?: string; readonly message: string } | null;
  }>;
}

const staffRescheduleBodySchema = z
  .object({
    endsAt: z.string().datetime({ offset: true }),
    startsAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), {
    message: 'The end time must be after the start time.',
  });

type StaffLifecycleExecutor = Pick<
  AppointmentLifecycleService,
  'executeStaffCancellation' | 'executeStaffReschedule'
>;

export interface AppointmentLifecycleRouteDependencies {
  readonly createLifecycleService: () => StaffLifecycleExecutor | null;
  readonly createServiceSupabaseClient: () => StaffCancellationRpc | null;
}

const defaultDependencies: AppointmentLifecycleRouteDependencies = {
  createLifecycleService: defaultLifecycleService,
  createServiceSupabaseClient: () =>
    createServiceSupabaseClient() as unknown as StaffCancellationRpc | null,
};

/** Owner/admin cancellation is authenticated here, then executes through the durable lifecycle state machine. */
export function createAppointmentLifecycleRoutes(
  dependencies: AppointmentLifecycleRouteDependencies = defaultDependencies,
): FastifyPluginCallback {
  return (app, _options, done) => {
    app.post(
      '/v1/scheduling/appointments/:locationId/:appointmentId/cancel',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const { appointmentId, locationId } = request.params as {
          appointmentId?: string;
          locationId?: string;
        };
        const service = dependencies.createLifecycleService();
        const supabase = dependencies.createServiceSupabaseClient();
        if (!validUuid(locationId) || !validUuid(appointmentId))
          return reply
            .code(400)
            .send({ code: 'INVALID_REQUEST', message: 'Appointment details are invalid.' });
        if (!service || !supabase || !request.authUser)
          return reply
            .code(503)
            .send({ code: 'SCHEDULING_UNAVAILABLE', message: 'Scheduling is unavailable.' });
        try {
          const rpc = supabase;
          const created = await rpc.rpc('create_staff_appointment_cancellation_intent', {
            target_appointment_id: appointmentId,
            target_location_id: locationId,
            target_user_id: request.authUser.id,
          });
          const intent = created.data?.[0]?.change_intent_id;
          if (created.error || !intent)
            return reply
              .code(403)
              .send({ code: 'FORBIDDEN', message: 'This appointment cannot be cancelled.' });
          const result = await service.executeStaffCancellation(intent);
          return reply
            .code(result.outcome === 'completed' ? 200 : 409)
            .send({ outcome: result.outcome });
        } catch {
          return reply.code(503).send({
            code: 'SCHEDULING_UNAVAILABLE',
            message: 'The cancellation could not be completed safely.',
          });
        }
      },
    );
    app.post(
      '/v1/scheduling/appointments/:locationId/:appointmentId/reschedule',
      { preHandler: app.authenticate },
      async (request, reply) => {
        const { appointmentId, locationId } = request.params as {
          appointmentId?: string;
          locationId?: string;
        };
        const parsed = staffRescheduleBodySchema.safeParse(request.body);
        const service = dependencies.createLifecycleService();
        const supabase = dependencies.createServiceSupabaseClient();
        if (!validUuid(locationId) || !validUuid(appointmentId) || !parsed.success)
          return reply
            .code(400)
            .send({ code: 'INVALID_REQUEST', message: 'Reschedule details are invalid.' });
        if (!service || !supabase || !request.authUser)
          return reply
            .code(503)
            .send({ code: 'SCHEDULING_UNAVAILABLE', message: 'Scheduling is unavailable.' });
        try {
          const rpc = supabase;
          const created = await rpc.rpc('create_staff_appointment_reschedule_intent', {
            target_appointment_id: appointmentId,
            target_location_id: locationId,
            target_user_id: request.authUser.id,
            target_starts_at: parsed.data.startsAt,
            target_ends_at: parsed.data.endsAt,
          });
          const intent = created.data?.[0]?.change_intent_id;
          if (created.error || !intent) {
            if (created.error?.message === 'Provider reschedule is unsupported')
              return reply.code(409).send({ outcome: 'handoff_required' });
            return reply
              .code(403)
              .send({ code: 'FORBIDDEN', message: 'This appointment cannot be rescheduled.' });
          }
          const result = await service.executeStaffReschedule(intent);
          return reply
            .code(result.outcome === 'completed' ? 200 : 409)
            .send({ outcome: result.outcome });
        } catch {
          return reply.code(503).send({
            code: 'SCHEDULING_UNAVAILABLE',
            message: 'The reschedule could not be completed safely.',
          });
        }
      },
    );
    done();
  };
}

export const appointmentLifecycleRoutes = createAppointmentLifecycleRoutes();
