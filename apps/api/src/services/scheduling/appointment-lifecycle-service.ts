import {
  BookingProviderError,
  type AvailabilitySlot,
  type AppointmentLifecycleRequest,
  type BookingAppointmentType,
  type BookingProvider,
  type BookingResource,
} from '@avenlyo/integrations';
import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ApiSchedulingConnectorRegistry } from './connector-registry.js';

type Row = Readonly<Record<string, unknown>>;
interface LifecycleRpc {
  rpc(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<{
    readonly data: readonly Row[] | null;
    readonly error: { readonly message: string } | null;
  }>;
}

function rows(value: readonly Row[] | null): readonly Row[] {
  return value ?? [];
}
function text(row: Row, key: string): string | null {
  return typeof row[key] === 'string' ? row[key] : null;
}
function requiredText(row: Row, key: string): string {
  const value = text(row, key);
  if (!value) throw new Error(`Appointment lifecycle RPC returned no ${key}.`);
  return value;
}
function provider(value: string): BookingProvider {
  if (value === 'ezyvet' || value === 'google_calendar') return value;
  throw new Error('Appointment lifecycle provider is invalid.');
}
function businessHours(
  value: unknown,
): Readonly<
  Record<
    string,
    { readonly close: string | null; readonly closed: boolean; readonly open: string | null }
  >
> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Appointment business hours are invalid.');
  return value as Readonly<
    Record<
      string,
      { readonly close: string | null; readonly closed: boolean; readonly open: string | null }
    >
  >;
}
function localDate(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!fields.year || !fields.month || !fields.day) throw new Error('Appointment time is invalid.');
  return `${fields.year}-${fields.month}-${fields.day}`;
}
function bool(row: Row, key: string): boolean {
  return row[key] === true;
}

/**
 * Provider-neutral lifecycle state machine. Customer tools supply opaque durable references only;
 * every provider identity and every mutation decision comes back from SECURITY DEFINER RPCs.
 */
export class AppointmentLifecycleService {
  private readonly rpc: LifecycleRpc;

  public constructor(
    private readonly input: {
      readonly connectors: ApiSchedulingConnectorRegistry;
      readonly supabase: SupabaseClient<Database>;
    },
  ) {
    this.rpc = input.supabase as unknown as LifecycleRpc;
  }

  public async getUpcomingAppointments(turn: {
    readonly conversationId: string;
    readonly triggeringInboundMessageId: string | null;
    /** Present only for an exact verified voice call; never model-controlled. */
    readonly trustedCallerE164?: string | null;
  }) {
    if (!turn.triggeringInboundMessageId) return [];
    const result = await this.rpc.rpc('create_conversation_appointment_management_targets', {
      target_conversation_id: turn.conversationId,
      target_inbound_message_id: turn.triggeringInboundMessageId,
      target_trusted_caller_e164: turn.trustedCallerE164 ?? null,
    });
    if (result.error) return [];
    return rows(result.data).flatMap((row) => {
      const appointmentReference = text(row, 'appointment_reference');
      const startsAt = text(row, 'starts_at');
      const endsAt = text(row, 'ends_at');
      const timezone = text(row, 'timezone');
      if (!appointmentReference || !startsAt || !endsAt || !timezone) return [];
      return [
        {
          appointmentReference,
          endsAt,
          startsAt,
          timezone,
          title: text(row, 'title') ?? 'Appointment',
        },
      ];
    });
  }

  public async getRescheduleOptions(
    input: { readonly appointmentReference: string; readonly dates: readonly string[] },
    turn: { readonly conversationId: string; readonly triggeringInboundMessageId: string | null },
  ) {
    if (!turn.triggeringInboundMessageId || input.dates.length === 0 || input.dates.length > 14)
      return [];
    const target = await this.targetContext(input.appointmentReference, turn);
    if (!target) return [];
    const connector = await this.input.connectors.forIntegration(
      provider(requiredText(target, 'provider')),
      requiredText(target, 'integration_id'),
    );
    if (!connector.appointmentLifecycle.canReschedule) return [];
    const typeUid = requiredText(target, 'appointment_type_uid');
    const originalResourceUid = text(target, 'original_resource_uid');
    const originalResourceName = text(target, 'original_resource_name');
    const catalogResult = await this.rpc.rpc('get_scheduling_bookable_catalog', {
      target_integration_id: requiredText(target, 'integration_id'),
    });
    if (catalogResult.error) return [];
    const catalog = rows(catalogResult.data);
    const resources =
      provider(requiredText(target, 'provider')) === 'google_calendar'
        ? originalResourceUid && originalResourceName
          ? [{ key: originalResourceUid, name: originalResourceName, schedulingScopeKey: null }]
          : []
        : catalog
            .flatMap((row): BookingResource[] =>
              text(row, 'appointment_type_uid') === typeUid &&
              text(row, 'resource_uid') &&
              text(row, 'resource_name')
                ? [
                    {
                      key: requiredText(row, 'resource_uid'),
                      name: requiredText(row, 'resource_name'),
                      schedulingScopeKey: null,
                    },
                  ]
                : [],
            )
            .slice(0, 5);
    if (!resources.length) return [];
    const timezone = requiredText(target, 'timezone');
    const slots = await connector.getAvailability({
      appointmentType: {
        defaultDurationMinutes: Number(target.default_duration_minutes),
        key: typeUid,
        name: requiredText(target, 'appointment_type_name'),
      },
      availabilityPolicy: {
        businessHours: businessHours(target.business_hours),
        minimumLeadMinutes: Number(target.minimum_lead_minutes),
      },
      dates: [...new Set(input.dates)].slice(0, 14),
      resources,
      timezone,
    });
    const originalStartAt = text(target, 'original_starts_at');
    const originalEndAt = text(target, 'original_ends_at');
    const safe = slots
      .filter(
        (slot) =>
          resources.some((resource) => resource.key === slot.resourceKey) &&
          // We never ask a provider to move an appointment into an overlapping copy of itself.
          (!originalStartAt ||
            !originalEndAt ||
            slot.endAt <= originalStartAt ||
            slot.startAt >= originalEndAt),
      )
      .slice(0, 5);
    if (!safe.length) return [];
    const candidates = await this.rpc.rpc('create_appointment_change_candidates', {
      target_conversation_id: turn.conversationId,
      target_inbound_message_id: turn.triggeringInboundMessageId,
      target_reference_id: input.appointmentReference,
      target_slots: safe.map((slot) => ({
        ends_at: slot.endAt,
        resource_uid: slot.resourceKey,
        starts_at: slot.startAt,
      })),
    });
    if (candidates.error) return [];
    return rows(candidates.data).flatMap((row) => {
      const candidateId = text(row, 'candidate_id');
      const startsAt = text(row, 'starts_at');
      const endsAt = text(row, 'ends_at');
      const resultTimezone = text(row, 'timezone');
      return candidateId && startsAt && endsAt && resultTimezone
        ? [{ candidateId, startsAt, endsAt, timezone: resultTimezone }]
        : [];
    });
  }

  public async prepareReschedule(
    input: { readonly candidateId: string },
    turn: { readonly conversationId: string; readonly triggeringInboundMessageId: string | null },
  ) {
    return this.prepare('reschedule', input.candidateId, turn);
  }

  public async prepareCancellation(
    input: { readonly appointmentReference: string },
    turn: { readonly conversationId: string; readonly triggeringInboundMessageId: string | null },
  ) {
    return this.prepare('cancel', null, turn, input.appointmentReference);
  }

  public async execute(
    input: { readonly changeIntentId: string; readonly toolCallId: string },
    turn: { readonly conversationId: string; readonly triggeringInboundMessageId: string | null },
  ) {
    if (!turn.triggeringInboundMessageId) return { outcome: 'confirmation_required' as const };
    const claimResult = await this.rpc.rpc('claim_appointment_change_intent', {
      target_change_intent_id: input.changeIntentId,
      target_conversation_id: turn.conversationId,
      target_inbound_message_id: turn.triggeringInboundMessageId,
      target_tool_call_id: input.toolCallId,
    });
    const claim = rows(claimResult.data)[0];
    const state = claim ? text(claim, 'state') : null;
    if (claimResult.error || !state || state === 'confirmation_required')
      return { outcome: 'confirmation_required' as const };
    if (state === 'completed') return { outcome: 'completed' as const };
    if (state === 'handoff_required') return { outcome: 'handoff_required' as const };
    if (state === 'configuration_changed') return { outcome: 'unavailable' as const };
    if (state === 'provider_success_pending_persistence')
      return this.complete(input.changeIntentId);
    const execution = await this.execution(input.changeIntentId);
    const connector = await this.input.connectors.forIntegration(
      provider(requiredText(execution, 'provider')),
      requiredText(execution, 'integration_id'),
    );
    const lifecycle: AppointmentLifecycleRequest = {
      appointmentKey: requiredText(execution, 'external_appointment_id'),
      bookingIntentId: text(execution, 'booking_intent_id'),
      integrationId: requiredText(execution, 'integration_id'),
      originalEndAt: requiredText(execution, 'original_ends_at'),
      originalStartAt: requiredText(execution, 'original_starts_at'),
      providerMutationTargetId: text(execution, 'provider_mutation_target_id'),
      resource: {
        key: requiredText(execution, 'original_resource_uid'),
        name: requiredText(execution, 'original_resource_name'),
        schedulingScopeKey: null,
      },
      timezone: requiredText(execution, 'timezone'),
    };
    let recoveryLifecycle = lifecycle;
    try {
      if (state === 'recovery' || state === 'provider_state_unknown')
        return this.recover(input.changeIntentId, execution, connector, lifecycle);
      if (!bool(execution, 'current_write_eligible')) {
        await this.fail(input.changeIntentId, 'failed', 'configuration_changed');
        return { outcome: 'unavailable' as const };
      }
      if (execution.operation === 'reschedule' && !connector.appointmentLifecycle.canReschedule) {
        await this.fail(
          input.changeIntentId,
          'handoff_required',
          'provider_reschedule_unsupported',
        );
        return { outcome: 'handoff_required' as const };
      }
      if (execution.operation === 'cancel' && !connector.appointmentLifecycle.canCancel) {
        await this.fail(input.changeIntentId, 'handoff_required', 'provider_cancel_unsupported');
        return { outcome: 'handoff_required' as const };
      }
      if (execution.operation === 'reschedule') {
        const lease = await this.rpc.rpc('claim_appointment_change_slot_lease', {
          target_change_intent_id: input.changeIntentId,
        });
        if (lease.error) {
          await this.fail(input.changeIntentId, 'awaiting_confirmation', 'slot_unavailable');
          return { outcome: 'unavailable' as const };
        }
        const targetStartAt = requiredText(execution, 'target_starts_at');
        const targetEndAt = requiredText(execution, 'target_ends_at');
        const targetResource = {
          key: requiredText(execution, 'target_resource_uid'),
          name: requiredText(execution, 'target_resource_name'),
          schedulingScopeKey: null,
        } as const;
        const appointmentType: BookingAppointmentType = {
          defaultDurationMinutes: Number(execution.default_duration_minutes),
          key: requiredText(execution, 'appointment_type_uid'),
          name: requiredText(execution, 'appointment_type_name'),
        };
        const available = await connector.getAvailability({
          appointmentType,
          dates: [localDate(targetStartAt, lifecycle.timezone)],
          resources: [targetResource],
          timezone: lifecycle.timezone,
          availabilityPolicy: {
            businessHours: businessHours(execution.business_hours),
            minimumLeadMinutes: Number(execution.minimum_lead_minutes),
          },
        });
        if (
          !available.some(
            (slot: AvailabilitySlot) =>
              slot.startAt === targetStartAt &&
              slot.endAt === targetEndAt &&
              slot.resourceKey === targetResource.key,
          )
        ) {
          await this.fail(input.changeIntentId, 'awaiting_confirmation', 'slot_unavailable');
          return { outcome: 'unavailable' as const };
        }
        if (!connector.resolveAppointmentMutationTarget)
          return this.providerResultUnknown(input.changeIntentId);
        const resolved = await connector.resolveAppointmentMutationTarget(lifecycle);
        if (resolved.kind !== 'resolved') {
          await this.fail(input.changeIntentId, 'handoff_required', 'provider_target_ambiguous');
          return { outcome: 'handoff_required' as const };
        }
        await this.persistMutationTarget(input.changeIntentId, resolved.targetId);
        recoveryLifecycle = { ...lifecycle, providerMutationTargetId: resolved.targetId };
        const providerResult = await connector.rescheduleAppointment({
          ...recoveryLifecycle,
          resource: targetResource,
          targetEndAt,
          targetStartAt,
        });
        if (providerResult.kind !== 'rescheduled')
          return this.providerResultUnknown(input.changeIntentId);
      } else {
        if (!connector.resolveAppointmentMutationTarget)
          return this.providerResultUnknown(input.changeIntentId);
        const resolved = await connector.resolveAppointmentMutationTarget(lifecycle);
        if (resolved.kind !== 'resolved') {
          await this.fail(input.changeIntentId, 'handoff_required', 'provider_target_ambiguous');
          return { outcome: 'handoff_required' as const };
        }
        await this.persistMutationTarget(input.changeIntentId, resolved.targetId);
        recoveryLifecycle = { ...lifecycle, providerMutationTargetId: resolved.targetId };
        const providerResult = await connector.cancelAppointment(recoveryLifecycle);
        if (providerResult.kind !== 'cancelled')
          return this.providerResultUnknown(input.changeIntentId);
      }
      await this.rpc.rpc('record_appointment_change_provider_success', {
        target_change_intent_id: input.changeIntentId,
        target_provider_state: 'confirmed',
      });
      return this.complete(input.changeIntentId);
    } catch (error) {
      if (
        error instanceof BookingProviderError &&
        ['network', 'timeout', 'provider_state_unknown', 'provider_conflict'].includes(
          error.category,
        )
      ) {
        return this.recover(input.changeIntentId, execution, connector, recoveryLifecycle);
      }
      await this.fail(
        input.changeIntentId,
        'failed',
        error instanceof BookingProviderError ? error.category : 'internal',
      );
      return { outcome: 'unknown' as const };
    }
  }

  /** Owner/admin path after the API has created a staff-attributed durable cancellation intent. */
  public async executeStaffCancellation(changeIntentId: string) {
    return this.executeStaffIntent(changeIntentId, 'cancel');
  }

  /** Staff chooses a UTC time explicitly; the provider availability read still has final authority. */
  public async executeStaffReschedule(changeIntentId: string) {
    return this.executeStaffIntent(changeIntentId, 'reschedule');
  }

  /**
   * The staff API retries one durable intent. Once a mutation target exists, the provider may
   * already have observed a write, so recovery is read-only and can never fall back to a write.
   */
  private async executeStaffIntent(
    changeIntentId: string,
    expectedOperation: 'cancel' | 'reschedule',
  ) {
    const execution = await this.execution(changeIntentId);
    if (requiredText(execution, 'operation') !== expectedOperation) {
      return { outcome: 'unavailable' as const };
    }
    const intentStatus = requiredText(execution, 'intent_status');
    if (intentStatus === 'completed') return { outcome: 'completed' as const };
    if (intentStatus === 'provider_success_pending_persistence')
      return this.complete(changeIntentId);
    if (intentStatus === 'handoff_required') return { outcome: 'handoff_required' as const };

    const connector = await this.input.connectors.forIntegration(
      provider(requiredText(execution, 'provider')),
      requiredText(execution, 'integration_id'),
    );
    const lifecycle = this.lifecycle(execution);
    if (
      intentStatus === 'provider_state_unknown' ||
      (intentStatus === 'executing' && lifecycle.providerMutationTargetId !== null)
    ) {
      return this.recover(changeIntentId, execution, connector, lifecycle);
    }
    if (intentStatus !== 'executing' || !bool(execution, 'current_write_eligible')) {
      await this.fail(changeIntentId, 'failed', 'configuration_changed');
      return { outcome: 'unavailable' as const };
    }
    let recoveryLifecycle = lifecycle;
    try {
      if (expectedOperation === 'cancel') {
        if (
          !connector.appointmentLifecycle.canCancel ||
          !connector.resolveAppointmentMutationTarget
        ) {
          await this.fail(changeIntentId, 'handoff_required', 'provider_cancel_unsupported');
          return { outcome: 'handoff_required' as const };
        }
        const resolved = await connector.resolveAppointmentMutationTarget(lifecycle);
        if (resolved.kind !== 'resolved') {
          await this.fail(changeIntentId, 'handoff_required', 'provider_target_ambiguous');
          return { outcome: 'handoff_required' as const };
        }
        await this.persistMutationTarget(changeIntentId, resolved.targetId);
        recoveryLifecycle = { ...lifecycle, providerMutationTargetId: resolved.targetId };
        const result = await connector.cancelAppointment(recoveryLifecycle);
        if (result.kind !== 'cancelled') return this.providerResultUnknown(changeIntentId);
      } else {
        if (
          !connector.appointmentLifecycle.canReschedule ||
          !connector.resolveAppointmentMutationTarget
        ) {
          await this.fail(changeIntentId, 'handoff_required', 'provider_reschedule_unsupported');
          return { outcome: 'handoff_required' as const };
        }
        const targetStartAt = requiredText(execution, 'target_starts_at');
        const targetEndAt = requiredText(execution, 'target_ends_at');
        const lease = await this.rpc.rpc('claim_appointment_change_slot_lease', {
          target_change_intent_id: changeIntentId,
        });
        if (lease.error) {
          await this.fail(changeIntentId, 'failed', 'slot_unavailable');
          return { outcome: 'unavailable' as const };
        }
        const appointmentType: BookingAppointmentType = {
          defaultDurationMinutes: Number(execution.default_duration_minutes),
          key: requiredText(execution, 'appointment_type_uid'),
          name: requiredText(execution, 'appointment_type_name'),
        };
        const available = await connector.getAvailability({
          appointmentType,
          dates: [localDate(targetStartAt, lifecycle.timezone)],
          resources: [lifecycle.resource],
          timezone: lifecycle.timezone,
          availabilityPolicy: {
            businessHours: businessHours(execution.business_hours),
            minimumLeadMinutes: Number(execution.minimum_lead_minutes),
          },
        });
        if (
          !available.some(
            (slot) =>
              slot.resourceKey === lifecycle.resource.key &&
              slot.startAt === targetStartAt &&
              slot.endAt === targetEndAt,
          )
        ) {
          await this.fail(changeIntentId, 'failed', 'slot_unavailable');
          return { outcome: 'unavailable' as const };
        }
        const resolved = await connector.resolveAppointmentMutationTarget(lifecycle);
        if (resolved.kind !== 'resolved') {
          await this.fail(changeIntentId, 'handoff_required', 'provider_target_ambiguous');
          return { outcome: 'handoff_required' as const };
        }
        await this.persistMutationTarget(changeIntentId, resolved.targetId);
        recoveryLifecycle = { ...lifecycle, providerMutationTargetId: resolved.targetId };
        const result = await connector.rescheduleAppointment({
          ...recoveryLifecycle,
          targetEndAt,
          targetStartAt,
        });
        if (result.kind !== 'rescheduled') return this.providerResultUnknown(changeIntentId);
      }
      await this.rpc.rpc('record_appointment_change_provider_success', {
        target_change_intent_id: changeIntentId,
        target_provider_state: 'confirmed',
      });
      return this.complete(changeIntentId);
    } catch (error) {
      if (
        error instanceof BookingProviderError &&
        ['network', 'timeout', 'provider_state_unknown', 'provider_conflict'].includes(
          error.category,
        )
      )
        return this.recover(changeIntentId, execution, connector, recoveryLifecycle);
      await this.fail(
        changeIntentId,
        'failed',
        error instanceof BookingProviderError ? error.category : 'internal',
      );
      return { outcome: 'unknown' as const };
    }
  }

  private async prepare(
    operation: 'cancel' | 'reschedule',
    candidateId: string | null,
    turn: { readonly conversationId: string; readonly triggeringInboundMessageId: string | null },
    referenceId?: string,
  ) {
    if (!turn.triggeringInboundMessageId) return { intent: null, outcome: 'not_found' as const };
    const result = await this.rpc.rpc('prepare_appointment_change_intent', {
      target_candidate_id: candidateId,
      target_conversation_id: turn.conversationId,
      target_inbound_message_id: turn.triggeringInboundMessageId,
      target_operation: operation,
      target_reference_id: referenceId ?? null,
    });
    const row = rows(result.data)[0];
    if (result.error || !row) return { intent: null, outcome: 'not_found' as const };
    return {
      intent: {
        changeIntentId: requiredText(row, 'change_intent_id'),
        operation: requiredText(row, 'operation'),
        startsAt: text(row, 'starts_at'),
        timezone: text(row, 'timezone'),
      },
      outcome: 'ready' as const,
    };
  }

  private async targetContext(
    reference: string,
    turn: { readonly conversationId: string; readonly triggeringInboundMessageId: string | null },
  ): Promise<Row | null> {
    if (!turn.triggeringInboundMessageId) return null;
    const result = await this.rpc.rpc('get_appointment_change_target_context_v2', {
      target_conversation_id: turn.conversationId,
      target_inbound_message_id: turn.triggeringInboundMessageId,
      target_reference_id: reference,
    });
    return result.error ? null : (rows(result.data)[0] ?? null);
  }
  private async execution(intentId: string): Promise<Row> {
    const result = await this.rpc.rpc('get_appointment_change_execution_context_v2', {
      target_change_intent_id: intentId,
    });
    const row = rows(result.data)[0];
    if (result.error || !row) throw new Error('Appointment execution context is unavailable.');
    return row;
  }
  private lifecycle(execution: Row): AppointmentLifecycleRequest {
    return {
      appointmentKey: requiredText(execution, 'external_appointment_id'),
      bookingIntentId: text(execution, 'booking_intent_id'),
      integrationId: requiredText(execution, 'integration_id'),
      originalEndAt: requiredText(execution, 'original_ends_at'),
      originalStartAt: requiredText(execution, 'original_starts_at'),
      providerMutationTargetId: text(execution, 'provider_mutation_target_id'),
      resource: {
        key: requiredText(execution, 'original_resource_uid'),
        name: requiredText(execution, 'original_resource_name'),
        schedulingScopeKey: null,
      },
      timezone: requiredText(execution, 'timezone'),
    };
  }
  private async complete(intentId: string) {
    const result = await this.rpc.rpc('complete_appointment_change_intent', {
      target_change_intent_id: intentId,
    });
    return result.error ? { outcome: 'unknown' as const } : { outcome: 'completed' as const };
  }
  private async fail(
    intentId: string,
    status: 'awaiting_confirmation' | 'failed' | 'handoff_required' | 'provider_state_unknown',
    category: string,
  ) {
    await this.rpc.rpc('fail_appointment_change_intent', {
      target_change_intent_id: intentId,
      target_error_category: category,
      target_status: status,
    });
  }
  private async persistMutationTarget(intentId: string, targetId: string) {
    const result = await this.rpc.rpc('persist_appointment_change_mutation_target', {
      target_change_intent_id: intentId,
      target_mutation_target_id: targetId,
    });
    if (result.error) throw new Error('Could not persist the provider mutation target.');
  }
  private async providerResultUnknown(intentId: string) {
    await this.fail(intentId, 'provider_state_unknown', 'provider_result_ambiguous');
    return { outcome: 'unknown' as const };
  }
  private async recover(
    intentId: string,
    execution: Row,
    connector: Awaited<ReturnType<ApiSchedulingConnectorRegistry['forIntegration']>>,
    lifecycle: AppointmentLifecycleRequest,
  ) {
    const result = await connector.getAppointmentState(
      execution.operation === 'reschedule'
        ? {
            ...lifecycle,
            targetEndAt: requiredText(execution, 'target_ends_at'),
            targetStartAt: requiredText(execution, 'target_starts_at'),
          }
        : lifecycle,
    );
    const succeeded =
      execution.operation === 'cancel'
        ? result.kind === 'cancelled'
        : result.kind === 'rescheduled';
    if (!succeeded) {
      await this.fail(intentId, 'provider_state_unknown', 'reconciliation_not_found');
      return { outcome: 'unknown' as const };
    }
    await this.rpc.rpc('record_appointment_change_provider_success', {
      target_change_intent_id: intentId,
      target_provider_state: 'reconciled',
    });
    return this.complete(intentId);
  }
}
