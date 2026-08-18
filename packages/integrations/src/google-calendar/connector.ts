import { Temporal } from '@js-temporal/polyfill';
import { BookingProviderError } from '../scheduling/errors';
import type {
  AvailabilityRequest,
  AvailabilitySlot,
  AppointmentLifecycleRequest,
  AppointmentLifecycleState,
  AppointmentMutationTarget,
  AppointmentRescheduleRequest,
  BookingConnector,
  BookingPartyResolution,
  BookingPartyResolutionRequest,
  BookingReconciliationRequest,
  BookingReconciliationResult,
  CreateBookingRequest,
  CreateBookingResult,
} from '../scheduling/types';

import { createGoogleAvailabilitySlots } from './availability';
import type { GoogleCalendarClient } from './client';

export function googleEventId(bookingIntentId: string): string {
  const id = bookingIntentId.toLowerCase().replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/.test(id)) throw new BookingProviderError('invalid_request');
  return id;
}

function exactEvent(
  event: {
    readonly end: string;
    readonly id: string;
    readonly privateProperties: Readonly<Record<string, string>>;
    readonly start: string;
    readonly status: string;
  },
  input: BookingReconciliationRequest,
): boolean {
  if (!input.bookingIntentId || !input.integrationId) return false;
  return (
    event.id === googleEventId(input.bookingIntentId) &&
    event.status === 'confirmed' &&
    Date.parse(event.start) === Date.parse(input.slot.startAt) &&
    Date.parse(event.end) === Date.parse(input.slot.endAt) &&
    event.privateProperties.avenlyo_booking_intent_id === input.bookingIntentId &&
    event.privateProperties.avenlyo_integration_id === input.integrationId
  );
}
function localDayBoundary(dateText: string, timezone: string, endOfDay: boolean): string {
  const date = Temporal.PlainDate.from(dateText);
  return Temporal.ZonedDateTime.from({
    timeZone: timezone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour: endOfDay ? 23 : 0,
    minute: endOfDay ? 59 : 0,
    second: endOfDay ? 59 : 0,
  })
    .toInstant()
    .toString();
}

/** Google is a calendar, not a CRM: a web visitor may book without a verified phone identity. */
export class GoogleCalendarConnector implements BookingConnector {
  public readonly appointmentLifecycle = { canCancel: true, canReschedule: true } as const;
  public readonly provider = 'google_calendar' as const;
  public constructor(private readonly client: GoogleCalendarClient) {}

  public resolveBookingParty(
    input: BookingPartyResolutionRequest,
  ): Promise<BookingPartyResolution> {
    return Promise.resolve({
      kind: 'resolved',
      party: {
        customer: {
          displayName:
            input.trustedContactDisplayName ??
            (!input.trustedCallerE164 && !input.trustedContactId ? 'Website visitor' : null),
          providerKey: null,
          trustedPhoneE164: input.trustedCallerE164,
        },
        subject: { displayName: input.subjectName, providerKey: null },
      },
    });
  }

  public async getAvailability(input: AvailabilityRequest): Promise<readonly AvailabilitySlot[]> {
    const policy = input.availabilityPolicy;
    if (!policy || input.resources.length === 0 || input.resources.length > 5)
      throw new BookingProviderError('invalid_request');
    const dates = input.dates.slice(0, 14);
    if (!dates.length) return [];
    const starts = dates.map((date) => localDayBoundary(date, input.timezone, false)).sort();
    const ends = dates.map((date) => localDayBoundary(date, input.timezone, true)).sort();
    const timeMin = starts[0];
    const timeMax = ends.at(-1);
    if (!timeMin || !timeMax) return [];
    const busyByResource = await this.client.freeBusy({
      calendarIds: input.resources.map((resource) => resource.key),
      timeMin,
      timeMax,
      timeZone: input.timezone,
    });
    return createGoogleAvailabilitySlots({
      appointmentType: input.appointmentType,
      businessHours: policy.businessHours,
      busyByResource,
      dates,
      minimumLeadMinutes: policy.minimumLeadMinutes,
      resources: input.resources,
      timezone: input.timezone,
    });
  }

  public async createBooking(input: CreateBookingRequest): Promise<CreateBookingResult> {
    if (!input.bookingIntentId || !input.integrationId)
      throw new BookingProviderError('invalid_request');
    const eventId = googleEventId(input.bookingIntentId);
    const summary = input.subject.displayName
      ? `${input.appointmentType.name} — ${input.subject.displayName}`
      : input.appointmentType.name;
    const event = await this.client.insertEvent(input.resource.key, {
      id: eventId,
      summary,
      description: `Booked by Avenlyo${input.customer.trustedPhoneE164 ? `\nCallback: ${input.customer.trustedPhoneE164}` : ''}`,
      start: { dateTime: input.slot.startAt, timeZone: input.slot.timezone },
      end: { dateTime: input.slot.endAt, timeZone: input.slot.timezone },
      extendedProperties: {
        private: {
          avenlyo_booking_intent_id: input.bookingIntentId,
          avenlyo_integration_id: input.integrationId,
        },
      },
    });
    if (event.status !== 'confirmed') throw new BookingProviderError('provider_state_unknown');
    return { appointmentKey: event.id, providerStatus: 'confirmed' };
  }

  public async getAppointmentState(input: AppointmentLifecycleRequest | AppointmentRescheduleRequest): Promise<AppointmentLifecycleState> {
    try {
      const event = await this.client.getEvent(input.resource.key, input.appointmentKey);
      if ('targetStartAt' in input && event.status === 'confirmed' && this.hasLifecycleMarkers(event, input) && Date.parse(event.start) === Date.parse(input.targetStartAt) && Date.parse(event.end) === Date.parse(input.targetEndAt))
        return { kind: 'rescheduled', appointmentKey: event.id };
      if (!this.exactLifecycleEvent(event, input)) return { kind: 'ambiguous' };
      return event.status === 'cancelled'
        ? { kind: 'cancelled', appointmentKey: event.id }
        : { kind: 'active', appointmentKey: event.id };
    } catch (error) {
      if (error instanceof BookingProviderError && error.category === 'not_found') return { kind: 'not_found' };
      throw error;
    }
  }

  public async resolveAppointmentMutationTarget(input: AppointmentLifecycleRequest): Promise<AppointmentMutationTarget> {
    const state = await this.getAppointmentState(input);
    return state.kind === 'active' || state.kind === 'cancelled'
      ? { kind: 'resolved', targetId: state.appointmentKey }
      : state.kind === 'not_found' ? state : { kind: 'ambiguous' };
  }

  public async cancelAppointment(input: AppointmentLifecycleRequest): Promise<AppointmentLifecycleState> {
    const event = await this.client.getEvent(input.resource.key, input.appointmentKey);
    if (!this.exactLifecycleEvent(event, input)) return { kind: 'ambiguous' };
    if (event.status === 'cancelled') return { kind: 'cancelled', appointmentKey: event.id };
    await this.client.deleteEvent(input.resource.key, event.id, event.etag);
    return { kind: 'cancelled', appointmentKey: event.id };
  }

  public async rescheduleAppointment(input: AppointmentRescheduleRequest): Promise<AppointmentLifecycleState> {
    const event = await this.client.getEvent(input.resource.key, input.appointmentKey);
    if (!this.exactLifecycleEvent(event, input) || event.status === 'cancelled') return { kind: 'ambiguous' };
    const updated = await this.client.updateEvent(input.resource.key, event.id, {
      ...event.resource,
      end: { dateTime: input.targetEndAt, timeZone: input.timezone },
      start: { dateTime: input.targetStartAt, timeZone: input.timezone },
    }, event.etag);
    if (updated.status !== 'confirmed' || !this.exactLifecycleEvent(updated, input, input.targetStartAt, input.targetEndAt)) return { kind: 'ambiguous' };
    return { kind: 'rescheduled', appointmentKey: updated.id };
  }

  public async reconcileBooking(
    input: BookingReconciliationRequest,
  ): Promise<BookingReconciliationResult> {
    if (!input.bookingIntentId) return { kind: 'not_found' };
    try {
      const event = await this.client.getEvent(
        input.resource.key,
        googleEventId(input.bookingIntentId),
      );
      if (!exactEvent(event, input)) throw new BookingProviderError('provider_conflict');
      return {
        kind: 'found',
        appointment: { appointmentKey: event.id, providerStatus: 'confirmed' },
      };
    } catch (error) {
      if (error instanceof BookingProviderError && error.category === 'not_found')
        return { kind: 'not_found' };
      throw error;
    }
  }

  private exactLifecycleEvent(
    event: { readonly end: string; readonly id: string; readonly privateProperties: Readonly<Record<string, string>>; readonly start: string; readonly status: string },
    input: AppointmentLifecycleRequest,
    expectedStart = input.originalStartAt,
    expectedEnd = input.originalEndAt,
  ): boolean {
    return this.hasLifecycleMarkers(event, input) &&
      Date.parse(event.start) === Date.parse(expectedStart) &&
      Date.parse(event.end) === Date.parse(expectedEnd);
  }

  private hasLifecycleMarkers(
    event: { readonly id: string; readonly privateProperties: Readonly<Record<string, string>> },
    input: AppointmentLifecycleRequest,
  ): boolean {
    return Boolean(input.bookingIntentId) && event.id === input.appointmentKey &&
      event.privateProperties.avenlyo_booking_intent_id === input.bookingIntentId &&
      event.privateProperties.avenlyo_integration_id === input.integrationId;
  }
}
