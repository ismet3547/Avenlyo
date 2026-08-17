import type {
  AvailabilitySlot,
  BookingAppointmentType,
  BookingConnector,
  BookingProvider,
  BookingResource,
  CreateBookingResult,
} from '@avenlyo/integrations';
import { BookingProviderError } from '@avenlyo/integrations';
import type { Database } from '@avenlyo/database';
import { hasExplicitBookingConfirmation, type VoiceSchedulingServices } from '@avenlyo/voice';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ApiSchedulingConnectorRegistry } from './connector-registry.js';

const MAX_DATES = 14;
const MAX_SLOTS = 5;

function utcDate(value: string): string | null {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
function outcomeForFailure(error: unknown): 'failed' | 'provider_state_unknown' | 'awaiting_confirmation' {
  if (error instanceof BookingProviderError) {
    if (['provider_state_unknown', 'timeout', 'network', 'provider_conflict'].includes(error.category)) return 'provider_state_unknown';
    if (error.category === 'slot_unavailable') return 'awaiting_confirmation';
  }
  return 'failed';
}
function providerStatus(result: CreateBookingResult): 'confirmed' | 'unconfirmed' {
  return result.providerStatus === 'confirmed' ? 'confirmed' : 'unconfirmed';
}
function localDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit', month: '2-digit', timeZone: timezone, year: 'numeric',
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!values.year || !values.month || !values.day) throw new BookingProviderError('invalid_request');
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Shared booking state machine. Provider choice, resource IDs, business hours, and identities are
 * all loaded from trusted database configuration; the model only selects an offered candidate.
 */
export class VoiceBookingService implements VoiceSchedulingServices {
  public constructor(private readonly input: {
    readonly connectors: ApiSchedulingConnectorRegistry;
    readonly supabase: SupabaseClient<Database>;
  }) {}

  public async isEnabledForCall(context: { readonly callId: string }): Promise<boolean> {
    const scheduling = await this.context(context.callId);
    if (!scheduling) return false;
    const catalog = await this.catalog(scheduling.integration_id);
    if (!catalog.length) return false;
    await this.connector(scheduling.provider, scheduling.integration_id);
    return true;
  }

  public async getAvailableAppointments(input: { readonly appointmentType: string; readonly dates: readonly string[]; readonly toolCallId: string }, context: { readonly callId: string }) {
    const dates = this.validateDates(input.dates);
    const scheduling = await this.context(context.callId);
    if (!scheduling) return [];
    const catalog = await this.catalog(scheduling.integration_id);
    const appointmentType = catalog.find((row) => row.appointment_type_name.localeCompare(input.appointmentType, undefined, { sensitivity: 'accent' }) === 0);
    if (!appointmentType) return [];
    const resources = this.resourcesForType(catalog, appointmentType.appointment_type_uid);
    if (!resources.length) return [];
    const slots = (await this.connector(scheduling.provider, scheduling.integration_id)).getAvailability({
      appointmentType: { defaultDurationMinutes: appointmentType.default_duration_minutes, key: appointmentType.appointment_type_uid, name: appointmentType.appointment_type_name },
      availabilityPolicy: { businessHours: this.businessHours(scheduling.business_hours), minimumLeadMinutes: scheduling.minimum_lead_minutes },
      dates, resources, timezone: scheduling.timezone,
    });
    const safeSlots = (await slots).filter((slot) => resources.some((resource) => resource.key === slot.resourceKey)).slice(0, MAX_SLOTS);
    if (!safeSlots.length) return [];
    const { data, error } = await this.input.supabase.rpc('create_voice_booking_candidates', {
      available_slots: safeSlots.map((slot) => ({ appointment_type_uid: slot.appointmentTypeKey, ends_at: slot.endAt, resource_uid: slot.resourceKey, starts_at: slot.startAt })),
      target_call_id: context.callId,
    });
    if (error) throw new Error('Could not persist trusted availability candidates.');
    return data.map((row) => ({ candidateId: row.candidate_id, endsAt: row.ends_at, expiresAt: row.expires_at, resourceName: row.resource_name, startsAt: row.starts_at, timezone: row.timezone, typeName: row.appointment_type_name }));
  }

  public async prepareAppointmentBooking(input: { readonly candidateId: string; readonly subjectName: string | null; readonly toolCallId: string }, context: { readonly callId: string }) {
    const scheduling = await this.context(context.callId);
    if (!scheduling) return { intent: null, outcome: 'not_found' as const };
    const party = await (await this.connector(scheduling.provider, scheduling.integration_id)).resolveBookingParty({
      subjectName: input.subjectName, trustedCallerE164: scheduling.caller_e164,
      trustedContactDisplayName: scheduling.contact_display_name, trustedContactId: scheduling.contact_id,
    });
    if (party.kind !== 'resolved') return { intent: null, outcome: party.kind === 'ambiguous' ? 'ambiguous' as const : 'not_found' as const };
    const { data, error } = await this.input.supabase.rpc('prepare_voice_scheduling_booking_intent', {
      resolved_contact_uid: party.party.customer.providerKey ?? null,
      resolved_subject_name: party.party.subject.displayName,
      resolved_subject_uid: party.party.subject.providerKey ?? null,
      target_call_id: context.callId, target_candidate_id: input.candidateId, trusted_contact_id: scheduling.contact_id,
    });
    const row = data?.[0];
    if (error || !row) throw new Error('Could not prepare booking intent.');
    return { intent: { bookingIntentId: row.booking_intent_id, startsAt: row.starts_at, status: row.status, timezone: row.timezone, typeName: row.appointment_type_name }, outcome: 'ready' as const };
  }

  public async bookAppointment(input: { readonly bookingIntentId: string; readonly confirmationText: string | null; readonly toolCallId: string }, context: { readonly callId: string }) {
    if (!hasExplicitBookingConfirmation(input.confirmationText)) return { outcome: 'confirmation_required' as const };
    const { data, error } = await this.input.supabase.rpc('claim_voice_scheduling_booking_intent', { target_booking_intent_id: input.bookingIntentId, target_call_id: context.callId, target_tool_call_id: input.toolCallId });
    const claim = data?.[0];
    if (error || !claim || claim.state === 'confirmation_required') return { outcome: 'confirmation_required' as const };
    if (claim.state === 'completed') return { outcome: 'booked' as const };
    if (claim.state === 'provider_state_unknown') return { outcome: 'unknown' as const };
    try {
      const execution = await this.execution(input.bookingIntentId);
      if (claim.state === 'provider_success_pending_persistence') return this.persistProviderSuccess(input.bookingIntentId, execution.provider_appointment_id);
      const connector = await this.connector(execution.provider, execution.integration_id);
      const appointmentType: BookingAppointmentType = { defaultDurationMinutes: execution.default_duration_minutes, key: execution.appointment_type_uid, name: execution.appointment_type_name };
      const resource: BookingResource = { key: execution.resource_uid, name: execution.resource_name, schedulingScopeKey: null };
      const slot: AvailabilitySlot = { appointmentTypeKey: appointmentType.key, endAt: execution.ends_at, providerDisplayName: resource.name, resourceKey: resource.key, startAt: execution.starts_at, timezone: execution.timezone };
      const request = {
        appointmentType, bookingIntentId: input.bookingIntentId,
        customer: { displayName: execution.customer_display_name, providerKey: execution.external_contact_uid, trustedPhoneE164: execution.trusted_phone_e164 },
        description: 'Booked through Avenlyo inbound voice after caller confirmation.', integrationId: execution.integration_id,
        resource, slot, subject: { displayName: execution.subject_name, providerKey: execution.external_subject_uid },
      } as const;
      if (claim.state === 'booking_recovery') return this.reconcileWithoutPosting(input.bookingIntentId, connector, request);
      if (claim.state !== 'claimed') return { outcome: 'unknown' as const };
      const { error: leaseError } = await this.input.supabase.rpc('claim_booking_slot_lease', { target_booking_intent_id: input.bookingIntentId });
      if (leaseError) { await this.fail(input.bookingIntentId, 'awaiting_confirmation', 'slot_unavailable'); return { outcome: 'unavailable' as const }; }
      const available = await connector.getAvailability({
        appointmentType, availabilityPolicy: { businessHours: this.businessHours(execution.business_hours), minimumLeadMinutes: execution.minimum_lead_minutes }, dates: [localDate(execution.starts_at, execution.timezone)], resources: [resource], timezone: execution.timezone,
      });
      if (!available.some((candidate) => candidate.startAt === slot.startAt && candidate.endAt === slot.endAt && candidate.resourceKey === slot.resourceKey)) {
        await this.fail(input.bookingIntentId, 'awaiting_confirmation', 'slot_unavailable'); return { outcome: 'unavailable' as const };
      }
      let created: CreateBookingResult;
      try { created = await connector.createBooking(request); }
      catch (providerError) {
        if (providerError instanceof BookingProviderError && ['provider_state_unknown', 'timeout', 'network', 'provider_conflict'].includes(providerError.category) && connector.reconcileBooking) {
          const reconciled = await connector.reconcileBooking(request);
          if (reconciled.kind === 'found') created = reconciled.appointment;
          else { await this.fail(input.bookingIntentId, 'provider_state_unknown', providerError.category); return { outcome: 'unknown' as const }; }
        } else {
          const status = outcomeForFailure(providerError);
          await this.fail(input.bookingIntentId, status, providerError instanceof BookingProviderError ? providerError.category : 'internal');
          return status === 'awaiting_confirmation' ? { outcome: 'unavailable' as const } : { outcome: 'unknown' as const };
        }
      }
      const { error: recordError } = await this.input.supabase.rpc('record_voice_booking_provider_success', { target_booking_intent_id: input.bookingIntentId, target_external_appointment_id: created.appointmentKey, target_provider_status: providerStatus(created) });
      if (recordError) return { outcome: 'unknown' as const };
      return this.persistProviderSuccess(input.bookingIntentId, created.appointmentKey);
    } catch (error) {
      const status = outcomeForFailure(error);
      await this.fail(input.bookingIntentId, status, error instanceof BookingProviderError ? error.category : 'internal');
      return status === 'awaiting_confirmation' ? { outcome: 'unavailable' as const } : { outcome: 'unknown' as const };
    }
  }

  private async reconcileWithoutPosting(intentId: string, connector: BookingConnector, request: Parameters<BookingConnector['createBooking']>[0]) {
    if (!connector.reconcileBooking) { await this.fail(intentId, 'provider_state_unknown', 'reconciliation_unavailable'); return { outcome: 'unknown' as const }; }
    const reconciliation = await connector.reconcileBooking(request);
    if (reconciliation.kind !== 'found') { await this.fail(intentId, 'provider_state_unknown', 'reconciliation_not_found'); return { outcome: 'unknown' as const }; }
    const { error } = await this.input.supabase.rpc('record_voice_booking_provider_success', { target_booking_intent_id: intentId, target_external_appointment_id: reconciliation.appointment.appointmentKey, target_provider_status: providerStatus(reconciliation.appointment) });
    return error ? { outcome: 'unknown' as const } : this.persistProviderSuccess(intentId, reconciliation.appointment.appointmentKey);
  }
  private async persistProviderSuccess(intentId: string, appointmentId: string | null) {
    if (!appointmentId) return { outcome: 'unknown' as const };
    const { error } = await this.input.supabase.rpc('complete_voice_booking_intent', { target_booking_intent_id: intentId, target_external_appointment_id: appointmentId, target_provider_status: 'unconfirmed' });
    return error ? { outcome: 'unknown' as const } : { outcome: 'booked' as const };
  }
  private async context(callId: string) { const { data, error } = await this.input.supabase.rpc('get_voice_scheduling_context', { target_call_id: callId }); if (error) throw new Error('Could not read scheduling context.'); return data[0] ?? null; }
  private async catalog(integrationId: string) { const { data, error } = await this.input.supabase.rpc('get_scheduling_bookable_catalog', { target_integration_id: integrationId }); if (error) throw new Error('Could not read booking policy.'); return data; }
  private async execution(intentId: string) { const { data, error } = await this.input.supabase.rpc('get_voice_booking_execution_context', { target_booking_intent_id: intentId }); if (error || !data[0]) throw new Error('Booking execution context is unavailable.'); return data[0]; }
  private async connector(provider: BookingProvider, integrationId: string) { return this.input.connectors.forIntegration(provider, integrationId); }
  private async fail(intentId: string, status: 'awaiting_confirmation' | 'failed' | 'provider_state_unknown', category: string): Promise<void> { await this.input.supabase.rpc('fail_voice_booking_intent', { target_booking_intent_id: intentId, target_error_category: category, target_status: status }); }
  private validateDates(dates: readonly string[]): readonly string[] { if (!dates.length || dates.length > MAX_DATES) throw new BookingProviderError('invalid_request'); const today = new Date(); today.setUTCHours(0, 0, 0, 0); const latest = today.getTime() + 14 * 86_400_000; const safe = dates.map(utcDate); if (safe.some((date) => !date)) throw new BookingProviderError('invalid_request'); const values = safe as string[]; if (values.some((date) => { const value = Date.parse(`${date}T00:00:00.000Z`); return value < today.getTime() || value > latest; })) throw new BookingProviderError('invalid_request'); return [...new Set(values)]; }
  private resourcesForType(catalog: readonly { readonly appointment_type_uid: string; readonly resource_uid: string; readonly resource_name: string }[], typeUid: string): readonly BookingResource[] { const resources = new Map<string, BookingResource>(); for (const row of catalog) if (row.appointment_type_uid === typeUid) resources.set(row.resource_uid, { key: row.resource_uid, name: row.resource_name, schedulingScopeKey: null }); return [...resources.values()].slice(0, 5); }
  private businessHours(value: unknown): Readonly<Record<string, { readonly close: string | null; readonly closed: boolean; readonly open: string | null }>> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BookingProviderError('invalid_request'); return value as Readonly<Record<string, { readonly close: string | null; readonly closed: boolean; readonly open: string | null }>>; }
}
