import type { Database } from '@avenlyo/database';
import {
  type BookingAppointmentType,
  type CreateBookingResult,
  type BookingResource,
  BookingProviderError,
} from '@avenlyo/integrations';
import { hasExplicitBookingConfirmation, type VoiceSchedulingServices } from '@avenlyo/voice';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EzyVetIntegrationService } from './ezyvet-service.js';

const MAX_DATES = 14;
const MAX_SLOTS = 5;

function utcDate(value: string): string | null {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function safeFailure(
  error: unknown,
): 'failed' | 'provider_state_unknown' | 'awaiting_confirmation' {
  if (error instanceof BookingProviderError) {
    return ['provider_state_unknown', 'timeout', 'network'].includes(error.category)
      ? 'provider_state_unknown'
      : error.category === 'slot_unavailable'
        ? 'awaiting_confirmation'
        : 'failed';
  }
  return 'failed';
}

/**
 * Service-role-only bridge between replay-safe voice tools and ezyVet. Every provider identifier
 * comes from the catalog/intents stored by the database, never from the model.
 */
export class VoiceBookingService implements VoiceSchedulingServices {
  public constructor(
    private readonly input: {
      readonly ezyVet: EzyVetIntegrationService;
      readonly supabase: SupabaseClient<Database>;
    },
  ) {}

  public async isEnabledForCall(context: { readonly callId: string }): Promise<boolean> {
    const scheduling = await this.context(context.callId);
    if (!scheduling) return false;
    const connector = await this.input.ezyVet.connectorForIntegration(scheduling.integration_id);
    return (
      connector.supportsBooking() && (await this.catalog(scheduling.integration_id)).length > 0
    );
  }

  public async getAvailableAppointments(
    input: {
      readonly appointmentType: string;
      readonly dates: readonly string[];
      readonly toolCallId: string;
    },
    context: { readonly callId: string },
  ): Promise<
    readonly {
      readonly candidateId: string;
      readonly endsAt: string;
      readonly expiresAt: string;
      readonly resourceName: string;
      readonly startsAt: string;
      readonly timezone: string;
      readonly typeName: string;
    }[]
  > {
    const dates = this.validateDates(input.dates);
    const scheduling = await this.context(context.callId);
    if (!scheduling) return [];
    const catalog = await this.catalog(scheduling.integration_id);
    const appointmentType = catalog.find(
      (row) =>
        row.appointment_type_name.localeCompare(input.appointmentType, undefined, {
          sensitivity: 'accent',
        }) === 0,
    );
    if (!appointmentType) return [];
    const resources = this.resourcesForType(catalog, appointmentType.appointment_type_uid);
    if (!resources.length) return [];
    const connector = await this.input.ezyVet.connectorForIntegration(scheduling.integration_id);
    const slots = (
      await connector.getAvailability({
        appointmentType: {
          defaultDurationMinutes: appointmentType.default_duration_minutes,
          key: appointmentType.appointment_type_uid,
          name: appointmentType.appointment_type_name,
        },
        dates,
        resources,
        timezone: scheduling.site_timezone,
      })
    )
      .filter((slot) => resources.some((resource) => resource.key === slot.resourceKey))
      .slice(0, MAX_SLOTS);
    if (!slots.length) return [];
    const { data, error } = await this.input.supabase.rpc('create_voice_booking_candidates', {
      available_slots: slots.map((slot) => ({
        appointment_type_uid: slot.appointmentTypeKey,
        ends_at: slot.endAt,
        resource_uid: slot.resourceKey,
        starts_at: slot.startAt,
      })),
      target_call_id: context.callId,
    });
    if (error) throw new Error('Could not persist trusted availability candidates.');
    return data.map((row) => ({
      candidateId: row.candidate_id,
      endsAt: row.ends_at,
      expiresAt: row.expires_at,
      resourceName: row.resource_name,
      startsAt: row.starts_at,
      timezone: row.timezone,
      typeName: row.appointment_type_name,
    }));
  }

  public async prepareAppointmentBooking(
    input: {
      readonly candidateId: string;
      readonly petName: string;
      readonly toolCallId: string;
    },
    context: { readonly callId: string },
  ): Promise<{
    readonly intent: {
      readonly bookingIntentId: string;
      readonly startsAt: string;
      readonly status: string;
      readonly timezone: string;
      readonly typeName: string;
    } | null;
    readonly outcome: 'ambiguous' | 'not_found' | 'ready';
  }> {
    const scheduling = await this.context(context.callId);
    if (!scheduling?.caller_e164) return { intent: null, outcome: 'not_found' };
    const connector = await this.input.ezyVet.connectorForIntegration(scheduling.integration_id);
    const customer = await connector.resolveCustomer({ trustedCallerE164: scheduling.caller_e164 });
    if (customer.kind === 'ambiguous') return { intent: null, outcome: 'ambiguous' };
    if (customer.kind !== 'resolved') return { intent: null, outcome: 'not_found' };
    const subject = await connector.resolveSubject({
      customer: customer.customer,
      petName: input.petName,
    });
    if (subject.kind === 'ambiguous') return { intent: null, outcome: 'ambiguous' };
    if (subject.kind !== 'resolved') return { intent: null, outcome: 'not_found' };
    const { data, error } = await this.input.supabase.rpc('prepare_voice_booking_intent', {
      resolved_contact_uid: customer.customer.key,
      resolved_subject_name: subject.subject.displayName,
      resolved_subject_uid: subject.subject.key,
      target_call_id: context.callId,
      target_candidate_id: input.candidateId,
    });
    const row = data?.[0];
    if (error || !row) throw new Error('Could not prepare booking intent.');
    return {
      intent: {
        bookingIntentId: row.booking_intent_id,
        startsAt: row.starts_at,
        status: row.status,
        timezone: row.timezone,
        typeName: row.appointment_type_name,
      },
      outcome: 'ready',
    };
  }

  public async bookAppointment(
    input: {
      readonly bookingIntentId: string;
      readonly confirmationText: string | null;
      readonly toolCallId: string;
    },
    context: { readonly callId: string },
  ): Promise<{
    readonly outcome: 'booked' | 'confirmation_required' | 'unavailable' | 'unknown';
  }> {
    if (!hasExplicitBookingConfirmation(input.confirmationText)) {
      return { outcome: 'confirmation_required' };
    }
    const { data, error } = await this.input.supabase.rpc('claim_voice_booking_intent', {
      target_booking_intent_id: input.bookingIntentId,
      target_call_id: context.callId,
      target_tool_call_id: input.toolCallId,
    });
    const claim = data?.[0];
    if (error || !claim || claim.state === 'confirmation_required')
      return { outcome: 'confirmation_required' };
    if (claim.state === 'completed') return { outcome: 'booked' };
    if (claim.state === 'provider_state_unknown') return { outcome: 'unknown' };
    try {
      const execution = await this.execution(input.bookingIntentId);
      if (claim.state === 'provider_success_pending_persistence') {
        return this.persistProviderSuccess(
          input.bookingIntentId,
          execution.provider_appointment_id,
        );
      }
      const connector = await this.input.ezyVet.connectorForIntegration(execution.integration_id);
      const appointmentType: BookingAppointmentType = {
        defaultDurationMinutes: execution.default_duration_minutes,
        key: execution.appointment_type_uid,
        name: execution.appointment_type_name,
      };
      const resource: BookingResource = {
        key: execution.resource_uid,
        name: execution.resource_name,
        schedulingScopeKey: 'catalog-validated',
      };
      const requestBase = {
        appointmentType,
        customer: { displayName: null, key: execution.external_contact_uid },
        description: 'Booked through Avenlyo inbound voice after caller confirmation.',
        resource,
        subject: { displayName: execution.subject_name, key: execution.external_subject_uid },
      } as const;
      if (claim.state === 'booking_recovery') {
        return this.reconcileWithoutPosting(
          input.bookingIntentId,
          connector,
          requestBase,
          execution,
        );
      }
      if (claim.state !== 'claimed') return { outcome: 'unknown' };
      // Recheck only the exact saved candidate, immediately before the one allowed provider POST.
      const slots = await connector.getAvailability({
        appointmentType,
        dates: [execution.starts_at.slice(0, 10)],
        resources: [resource],
        timezone: execution.timezone,
      });
      const slot = slots.find(
        (candidate) =>
          candidate.startAt === execution.starts_at &&
          candidate.endAt === execution.ends_at &&
          candidate.resourceKey === resource.key,
      );
      if (!slot) {
        await this.fail(input.bookingIntentId, 'awaiting_confirmation', 'unavailable');
        return { outcome: 'unavailable' };
      }
      const request = {
        ...requestBase,
        slot,
      } as const;
      let created: CreateBookingResult;
      try {
        created = await connector.createBooking(request);
      } catch (error) {
        if (
          error instanceof BookingProviderError &&
          ['provider_state_unknown', 'timeout', 'network'].includes(error.category)
        ) {
          const reconciliation = await connector.reconcileBooking({
            appointmentType: request.appointmentType,
            customer: request.customer,
            resource: request.resource,
            slot: request.slot,
            subject: request.subject,
          });
          if (reconciliation.kind === 'found') {
            created = reconciliation.appointment;
          } else {
            await this.fail(input.bookingIntentId, 'provider_state_unknown', error.category);
            return { outcome: 'unknown' };
          }
        } else {
          const status = safeFailure(error);
          await this.fail(
            input.bookingIntentId,
            status,
            error instanceof BookingProviderError ? error.category : 'internal',
          );
          return status === 'awaiting_confirmation'
            ? { outcome: 'unavailable' }
            : { outcome: 'unknown' };
        }
      }
      const { error: recordedError } = await this.input.supabase.rpc(
        'record_voice_booking_provider_success',
        {
          target_booking_intent_id: input.bookingIntentId,
          target_external_appointment_id: created.appointmentKey,
          target_provider_status:
            created.providerStatus === 'confirmed' ? 'confirmed' : 'unconfirmed',
        },
      );
      // If this write fails after a provider success, the next call reconciles instead of posting again.
      if (recordedError) return { outcome: 'unknown' };
      return this.persistProviderSuccess(input.bookingIntentId, created.appointmentKey);
    } catch (error) {
      // This catch only covers pre-POST work or reconciliation. It never changes a recorded success.
      const status = safeFailure(error);
      if (claim.state === 'provider_success_pending_persistence') return { outcome: 'unknown' };
      await this.fail(
        input.bookingIntentId,
        status,
        error instanceof BookingProviderError ? error.category : 'internal',
      );
      return status === 'awaiting_confirmation'
        ? { outcome: 'unavailable' }
        : { outcome: 'unknown' };
    }
  }

  private async reconcileWithoutPosting(
    intentId: string,
    connector: Awaited<ReturnType<EzyVetIntegrationService['connectorForIntegration']>>,
    request: {
      readonly appointmentType: BookingAppointmentType;
      readonly customer: { readonly displayName: null; readonly key: string };
      readonly resource: BookingResource;
      readonly subject: { readonly displayName: string; readonly key: string };
    },
    execution: Awaited<ReturnType<VoiceBookingService['execution']>>,
  ): Promise<{ readonly outcome: 'booked' | 'unknown' }> {
    const reconciliation = await connector.reconcileBooking({
      ...request,
      slot: {
        appointmentTypeKey: request.appointmentType.key,
        endAt: execution.ends_at,
        providerDisplayName: request.resource.name,
        resourceKey: request.resource.key,
        startAt: execution.starts_at,
        timezone: execution.timezone,
      },
    });
    if (reconciliation.kind !== 'found') {
      await this.fail(intentId, 'provider_state_unknown', 'reconciliation_not_found');
      return { outcome: 'unknown' };
    }
    const { error } = await this.input.supabase.rpc('record_voice_booking_provider_success', {
      target_booking_intent_id: intentId,
      target_external_appointment_id: reconciliation.appointment.appointmentKey,
      target_provider_status:
        reconciliation.appointment.providerStatus === 'confirmed' ? 'confirmed' : 'unconfirmed',
    });
    if (error) return { outcome: 'unknown' };
    return this.persistProviderSuccess(intentId, reconciliation.appointment.appointmentKey);
  }

  private async persistProviderSuccess(
    intentId: string,
    providerAppointmentId: string | null,
  ): Promise<{ readonly outcome: 'booked' | 'unknown' }> {
    if (!providerAppointmentId) return { outcome: 'unknown' };
    const { error } = await this.input.supabase.rpc('complete_voice_booking_intent', {
      target_booking_intent_id: intentId,
      target_external_appointment_id: providerAppointmentId,
      target_provider_status: 'unconfirmed',
    });
    return error ? { outcome: 'unknown' } : { outcome: 'booked' };
  }

  private async context(callId: string) {
    const { data, error } = await this.input.supabase.rpc('get_voice_ezyvet_scheduling_context', {
      target_call_id: callId,
    });
    if (error) throw new Error('Could not read scheduling context.');
    return data[0] ?? null;
  }

  private async catalog(integrationId: string) {
    const { data, error } = await this.input.supabase.rpc('get_ezyvet_bookable_catalog', {
      target_integration_id: integrationId,
    });
    if (error) throw new Error('Could not read booking policy.');
    return data;
  }

  private async execution(intentId: string) {
    const { data, error } = await this.input.supabase.rpc('get_voice_booking_execution_context', {
      target_booking_intent_id: intentId,
    });
    if (error || !data[0]) throw new Error('Booking execution context is unavailable.');
    return data[0];
  }

  private async fail(
    intentId: string,
    status: 'awaiting_confirmation' | 'failed' | 'provider_state_unknown',
    category: string,
  ): Promise<void> {
    await this.input.supabase.rpc('fail_voice_booking_intent', {
      target_booking_intent_id: intentId,
      target_error_category: category,
      target_status: status,
    });
  }

  private validateDates(dates: readonly string[]): readonly string[] {
    if (!dates.length || dates.length > MAX_DATES)
      throw new BookingProviderError('invalid_request');
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const latest = today.getTime() + 14 * 86_400_000;
    const normalized = dates.map(utcDate);
    if (normalized.some((date) => !date)) throw new BookingProviderError('invalid_request');
    const safe = normalized as string[];
    if (
      safe.some((date) => {
        const value = Date.parse(`${date}T00:00:00.000Z`);
        return value < today.getTime() || value > latest;
      })
    )
      throw new BookingProviderError('invalid_request');
    return [...new Set(safe)];
  }

  private resourcesForType(
    catalog: readonly {
      readonly appointment_type_uid: string;
      readonly resource_uid: string;
      readonly resource_name: string;
    }[],
    typeUid: string,
  ): readonly BookingResource[] {
    const unique = new Map<string, BookingResource>();
    for (const row of catalog) {
      if (row.appointment_type_uid === typeUid) {
        unique.set(row.resource_uid, {
          key: row.resource_uid,
          name: row.resource_name,
          schedulingScopeKey: 'catalog-validated',
        });
      }
    }
    return [...unique.values()].slice(0, 5);
  }
}
