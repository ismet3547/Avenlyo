import { randomUUID } from 'node:crypto';

import type { AppointmentReminderExecutionRow, Database } from '@avenlyo/database';
import type { BookingConnector } from '@avenlyo/integrations';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  classifyDatabaseError,
  classifyProviderError,
} from '../../observability/errors.js';
import type { WorkerObserver } from '../../observability/worker-observer.js';

import type { ApiSchedulingConnectorRegistry } from '../scheduling/connector-registry.js';

const IDLE_POLL_MS = 30_000;
const RECONCILIATION_BATCH_SIZE = 50;

/**
 * Claims durable reminders and revalidates an already-booked appointment with a read-only
 * provider operation before materialising its deterministic SMS message. It never creates,
 * changes, or retries a provider appointment.
 */
export class AppointmentReminderWorker {
  private active = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private tickErrorCode: string | null = null;
  private readonly workerId = `reminder-${randomUUID()}`;

  public constructor(
    private readonly input: {
      readonly concurrency?: number;
      readonly connectors: ApiSchedulingConnectorRegistry;
      readonly observer?: WorkerObserver;
      readonly supabase: SupabaseClient<Database>;
    },
  ) {}

  public start(): void {
    if (this.stopped || this.timer) return;
    this.input.observer?.onStart();
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
    this.input.observer?.onStop();
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.active || this.stopped) return;
    this.active = true;
    this.tickErrorCode = null;
    this.inFlight = this.run();
    try {
      await this.inFlight;
      // A tick that finds no work is still a successful tick: "no work" is a healthy component.
      this.input.observer?.onTick(
        this.tickErrorCode ? { errorCode: this.tickErrorCode, ok: false } : { ok: true },
      );
    } catch (error) {
      this.input.observer?.onTick({ errorCode: classifyProviderError(error), ok: false });
    } finally {
      this.inFlight = null;
      this.active = false;
      this.schedule(IDLE_POLL_MS);
    }
  }

  private async run(): Promise<void> {
    // A bounded reconciliation admits appointments only when they enter the 30-day horizon and
    // catches policy-version changes without turning settings saves into unbounded requests.
    let claims: readonly { readonly reminder_id: string }[];
    try {
      const reconciled = await this.input.supabase.rpc(
        'reconcile_appointment_reminder_schedules',
        { target_limit: RECONCILIATION_BATCH_SIZE },
      );
      if (reconciled.error) {
        this.tickErrorCode = 'database_unavailable';
        return;
      }
      const claimed = await this.input.supabase.rpc('claim_due_appointment_reminders', {
        target_limit: this.input.concurrency ?? 4,
        target_worker_id: this.workerId,
      });
      if (claimed.error) return;
      claims = claimed.data;
    } catch (error) {
      // Reconciliation and claiming are database calls. A thrown transport failure here is
      // never a provider outage.
      this.tickErrorCode = classifyDatabaseError(error);
      return;
    }
    if (!claims.length) return;
    await Promise.all(claims.map((claim) => this.process(claim.reminder_id)));
  }

  private async process(reminderId: string): Promise<void> {
    const { data, error } = await this.input.supabase.rpc(
      'get_appointment_reminder_execution_context',
      { target_reminder_id: reminderId },
    );
    const context = data?.[0];
    if (error || !context) {
      await this.record(reminderId, 'provider_unavailable');
      return;
    }

    const outcome = await this.revalidate(context);
    await this.record(reminderId, outcome);
    if (outcome !== 'confirmed' && outcome !== 'not_required') return;

    const { error: materializeError } = await this.input.supabase.rpc(
      'create_appointment_reminder_message',
      { target_reminder_id: reminderId },
    );
    if (materializeError) throw new Error('Appointment reminder materialisation failed.');
  }

  private async record(
    reminderId: string,
    outcome: 'confirmed' | 'not_required' | 'provider_not_confirmed' | 'provider_unavailable',
  ): Promise<void> {
    const { error } = await this.input.supabase.rpc('record_appointment_reminder_revalidation', {
      target_outcome: outcome,
      target_reminder_id: reminderId,
    });
    if (error) throw new Error('Appointment reminder revalidation persistence failed.');
  }

  private async revalidate(
    context: AppointmentReminderExecutionRow,
  ): Promise<'confirmed' | 'not_required' | 'provider_not_confirmed' | 'provider_unavailable'> {
    if (!context.provider && !context.integration_id && !context.external_appointment_id) {
      return 'not_required';
    }
    if (
      !context.provider ||
      !context.integration_id ||
      !context.external_appointment_id ||
      !context.ends_at ||
      context.integration_status !== 'connected' ||
      !context.provider_resource_key ||
      !context.appointment_type_key
    ) {
      return 'provider_unavailable';
    }

    try {
      const connector = await this.input.connectors.forIntegration(
        context.provider,
        context.integration_id,
      );
      return await this.reconcile(connector, context);
    } catch {
      // Provider reads may be unavailable; skipping avoids an unverified reminder and no provider
      // write is ever retried from this path.
      return 'provider_unavailable';
    }
  }

  private async reconcile(
    connector: BookingConnector,
    context: AppointmentReminderExecutionRow,
  ): Promise<'confirmed' | 'provider_not_confirmed'> {
    if (
      !connector.reconcileBooking ||
      !context.provider_resource_key ||
      !context.appointment_type_key ||
      !context.ends_at
    ) {
      return 'provider_not_confirmed';
    }
    const result = await connector.reconcileBooking({
      appointmentType: {
        defaultDurationMinutes: Math.max(
          10,
          Math.round((Date.parse(context.ends_at) - Date.parse(context.starts_at)) / 60_000),
        ),
        key: context.appointment_type_key,
        name: 'Scheduled appointment',
      },
      ...(context.booking_intent_id ? { bookingIntentId: context.booking_intent_id } : {}),
      ...(context.integration_id ? { integrationId: context.integration_id } : {}),
      customer: {
        displayName: null,
        providerKey: context.external_contact_uid,
        trustedPhoneE164: context.trusted_sms_recipient_e164,
      },
      resource: {
        key: context.provider_resource_key,
        name: 'Scheduled resource',
        schedulingScopeKey: null,
      },
      slot: {
        appointmentTypeKey: context.appointment_type_key,
        endAt: context.ends_at,
        providerDisplayName: null,
        resourceKey: context.provider_resource_key,
        startAt: context.starts_at,
        timezone: context.timezone,
      },
      subject: { displayName: null, providerKey: context.external_subject_uid },
    });
    return result.kind === 'found' &&
      result.appointment.appointmentKey === context.external_appointment_id
      ? 'confirmed'
      : 'provider_not_confirmed';
  }
}
