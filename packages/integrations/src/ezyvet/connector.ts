import type {
  AvailabilityRequest,
  AvailabilitySlot,
  AppointmentLifecycleRequest,
  AppointmentLifecycleState,
  AppointmentMutationTarget,
  AppointmentRescheduleRequest,
  BookingConnector,
  BookingReconciliationRequest,
  BookingReconciliationResult,
  CreateBookingRequest,
  CreateBookingResult,
  CustomerResolution,
  CustomerResolutionRequest,
  BookingPartyResolution,
  BookingPartyResolutionRequest,
  SchedulingCatalog,
  SubjectResolution,
  SubjectResolutionRequest,
} from '../scheduling/types';
import { BookingProviderError } from '../scheduling/errors';

import { loadAvailability } from './availability';
import { resolveOwnedAnimal } from './animals';
import { createEzyVetBooking } from './booking';
import { loadAppointmentTypes, loadCalendarResources } from './catalog';
import type { EzyVetClient } from './client';
import { resolveExactPhoneCustomer } from './contacts';
import { reconcileEzyVetBooking } from './reconciliation';
import { array, record, string } from './schemas';
import type { EzyVetCatalogConnector, EzyVetSite } from './types';

const LIFECYCLE_LOOKUP_PAGE_SIZE = 100;
const LIFECYCLE_LOOKUP_MAX_PAGES = 4;
const LIFECYCLE_LOOKUP_WINDOW_MS = 15 * 60 * 1000;

function siteFromPayload(value: unknown): EzyVetSite {
  try {
    const root = record(value);
    const data = record(root.data);
    const id = string(data.id);
    const timezoneReference = record(record(data.relationships).timezone).data;
    const timezoneId = string(record(timezoneReference).id);
    const timezone = array(root.included)
      .map(record)
      .find((entry) => string(entry.type) === 'timezone' && string(entry.id) === timezoneId);
    const timezoneName = timezone ? string(record(timezone.attributes).name) : null;
    if (!id || !timezoneId || !timezoneName || !validTimeZone(timezoneName)) {
      throw new Error('invalid site information');
    }
    return { id, timezone: timezoneName };
  } catch {
    throw new Error('ezyVet site information was incomplete or invalid.');
  }
}

function validTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export class EzyVetConnector implements BookingConnector, EzyVetCatalogConnector {
  public readonly appointmentLifecycle = { canCancel: true, canReschedule: false } as const;
  public readonly provider = 'ezyvet' as const;

  public constructor(private readonly client: EzyVetClient) {}

  public supportsBooking(): boolean {
    return this.client.supportsEzyCab();
  }

  public async createBooking(input: CreateBookingRequest): Promise<CreateBookingResult> {
    return createEzyVetBooking(this.client, input);
  }

  public async reconcileBooking(
    input: BookingReconciliationRequest,
  ): Promise<BookingReconciliationResult> {
    return reconcileEzyVetBooking(this.client, input);
  }

  public async getAvailability(input: AvailabilityRequest): Promise<readonly AvailabilitySlot[]> {
    return loadAvailability(this.client, input);
  }

  public async getSchedulingCatalog(): Promise<SchedulingCatalog> {
    const [site, appointmentTypes, resources] = await Promise.all([
      this.getSite(),
      loadAppointmentTypes(this.client),
      loadCalendarResources(this.client),
    ]);
    return { appointmentTypes, resources, site };
  }

  public async getSite(): Promise<EzyVetSite> {
    return siteFromPayload(await this.client.getCore('/v3/siteInformation'));
  }

  public async resolveCustomer(input: CustomerResolutionRequest): Promise<CustomerResolution> {
    return resolveExactPhoneCustomer(this.client, input.trustedCallerE164);
  }

  public async resolveSubject(input: SubjectResolutionRequest): Promise<SubjectResolution> {
    return resolveOwnedAnimal(this.client, input.customer, input.petName);
  }

  public async getAppointmentState(
    input: AppointmentLifecycleRequest | AppointmentRescheduleRequest,
  ): Promise<AppointmentLifecycleState> {
    const targetId = input.providerMutationTargetId;
    if (!targetId || !this.numericId(targetId)) return { kind: 'ambiguous' };
    const appointment = await this.readExactLifecycleAppointment(input.appointmentKey, targetId);
    if (!appointment) return { kind: 'not_found' };
    return appointment.active
      ? { kind: 'active', appointmentKey: input.appointmentKey }
      : { kind: 'cancelled', appointmentKey: input.appointmentKey };
  }

  public async resolveAppointmentMutationTarget(
    input: AppointmentLifecycleRequest,
  ): Promise<AppointmentMutationTarget> {
    if (input.providerMutationTargetId && this.numericId(input.providerMutationTargetId)) {
      return { kind: 'resolved', targetId: input.providerMutationTargetId };
    }
    const matches = await this.findBoundedLifecycleAppointments(input);
    if (matches.length === 0) return { kind: 'not_found' };
    if (matches.length !== 1) return { kind: 'ambiguous' };
    return { kind: 'resolved', targetId: matches[0]!.id };
  }

  public async cancelAppointment(
    input: AppointmentLifecycleRequest,
  ): Promise<AppointmentLifecycleState> {
    const targetId = input.providerMutationTargetId;
    if (!targetId || !this.numericId(targetId)) return { kind: 'ambiguous' };
    await this.client.patchCore(`/v2/appointment/${encodeURIComponent(targetId)}`, {
      cancel: true,
      cancellation_reason_text: 'Cancelled by customer through Avenlyo',
    });
    const appointment = await this.readExactLifecycleAppointment(input.appointmentKey, targetId);
    return appointment && !appointment.active
      ? { kind: 'cancelled', appointmentKey: input.appointmentKey }
      : { kind: 'ambiguous' };
  }

  public rescheduleAppointment(
    input: AppointmentRescheduleRequest,
  ): Promise<AppointmentLifecycleState> {
    void input;
    return Promise.reject(
      new BookingProviderError(
        'invalid_request',
        'This provider requires clinic handling for rescheduling.',
      ),
    );
  }

  public async resolveBookingParty(
    input: BookingPartyResolutionRequest,
  ): Promise<BookingPartyResolution> {
    if (!input.trustedCallerE164 || !input.subjectName) return { kind: 'unresolved' };
    const customer = await this.resolveCustomer({ trustedCallerE164: input.trustedCallerE164 });
    if (customer.kind !== 'resolved') return customer;
    const subject = await this.resolveSubject({
      customer: customer.customer,
      petName: input.subjectName,
    });
    if (subject.kind !== 'resolved') return subject;
    return {
      kind: 'resolved',
      party: {
        customer: {
          displayName: customer.customer.displayName,
          providerKey: customer.customer.key,
          trustedPhoneE164: input.trustedCallerE164,
        },
        subject: { displayName: subject.subject.displayName, providerKey: subject.subject.key },
      },
    };
  }

  private async readExactLifecycleAppointment(uid: string, id: string) {
    const matches = this.appointments(
      await this.client.getLifecycleCore('/v2/appointment', { id }),
    ).filter((appointment) => appointment.id === id && appointment.uid === uid);
    return matches.length === 1 ? matches[0]! : null;
  }

  /**
   * ezyVet's v2.1 calendar read supports a bounded start-time/resource filter and token paging.
   * We never scan an unbounded appointment history merely to turn the stored UID into the numeric
   * v2 PATCH identity. A cursor carries the original filter snapshot, so subsequent reads send
   * only nextToken as required by the provider contract.
   */
  private async findBoundedLifecycleAppointments(
    input: AppointmentLifecycleRequest,
  ): Promise<readonly { readonly active: boolean; readonly id: string; readonly uid: string }[]> {
    const originalStart = new Date(input.originalStartAt);
    if (Number.isNaN(originalStart.getTime()) || !input.resource.key) return [];
    const lower = new Date(originalStart.getTime() - LIFECYCLE_LOOKUP_WINDOW_MS).toISOString();
    const upper = new Date(originalStart.getTime() + LIFECYCLE_LOOKUP_WINDOW_MS).toISOString();
    const matches: Array<{ readonly active: boolean; readonly id: string; readonly uid: string }> =
      [];
    let nextToken: string | null = null;
    for (let page = 0; page < LIFECYCLE_LOOKUP_MAX_PAGES; page += 1) {
      const response = await this.client.getLifecycleCore(
        '/v2.1/calendar/appointments',
        nextToken
          ? { nextToken }
          : {
              'filter[resources.uid][in]': JSON.stringify([input.resource.key]),
              'filter[start_at][gte]': lower,
              'filter[start_at][lte]': upper,
              pageSize: String(LIFECYCLE_LOOKUP_PAGE_SIZE),
            },
      );
      matches.push(
        ...this.calendarAppointments(response).filter(
          (appointment) => appointment.uid === input.appointmentKey,
        ),
      );
      nextToken = this.nextToken(response);
      if (!nextToken) break;
    }
    return matches;
  }

  /** ezyVet documents appointment list items as { appointment: { id, uid, active } }. */
  private appointments(
    value: unknown,
  ): readonly { readonly active: boolean; readonly id: string; readonly uid: string }[] {
    if (
      !value ||
      typeof value !== 'object' ||
      !Array.isArray((value as Record<string, unknown>).items)
    )
      return [];
    return (value as { readonly items: readonly unknown[] }).items.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const appointment = (item as Record<string, unknown>).appointment;
      if (!appointment || typeof appointment !== 'object') return [];
      const fields = appointment as Record<string, unknown>;
      const id = typeof fields.id === 'number' ? String(fields.id) : fields.id;
      return typeof id === 'string' &&
        this.numericId(id) &&
        typeof fields.uid === 'string' &&
        typeof fields.active === 'boolean'
        ? [{ active: fields.active, id, uid: fields.uid }]
        : [];
    });
  }

  /** The newer, documented calendar list returns appointment records directly in data. */
  private calendarAppointments(
    value: unknown,
  ): readonly { readonly active: boolean; readonly id: string; readonly uid: string }[] {
    if (
      !value ||
      typeof value !== 'object' ||
      !Array.isArray((value as Record<string, unknown>).data)
    )
      return [];
    return (value as { readonly data: readonly unknown[] }).data.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const fields = entry as Record<string, unknown>;
      const id = typeof fields.id === 'number' ? String(fields.id) : fields.id;
      return typeof id === 'string' &&
        this.numericId(id) &&
        typeof fields.uid === 'string' &&
        typeof fields.active === 'boolean'
        ? [{ active: fields.active, id, uid: fields.uid }]
        : [];
    });
  }

  private nextToken(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const meta = (value as Record<string, unknown>).meta;
    if (!meta || typeof meta !== 'object') return null;
    const token = (meta as Record<string, unknown>).nextToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  }

  private numericId(value: string): boolean {
    return /^[1-9][0-9]*$/.test(value);
  }
}
