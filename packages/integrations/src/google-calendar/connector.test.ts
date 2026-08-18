import { describe, expect, it, vi } from 'vitest';

import { BookingProviderError } from '../scheduling/errors';
import type { CreateBookingRequest } from '../scheduling/types';

import { GoogleCalendarClient } from './client';
import { GoogleCalendarConnector, googleEventId } from './connector';

const bookingIntentId = '6c0df1cb-2487-4e71-96b4-2e2667f4d2b1';
const request: CreateBookingRequest = {
  appointmentType: { defaultDurationMinutes: 30, key: 'consultation', name: 'Consultation' },
  bookingIntentId,
  customer: { displayName: 'Jamie', trustedPhoneE164: '+14155550123' },
  description: 'Booked by Avenlyo.',
  integrationId: 'integration_1',
  resource: { key: 'calendar_1', name: 'Room One', schedulingScopeKey: null },
  slot: {
    appointmentTypeKey: 'consultation',
    endAt: '2026-09-01T10:30:00.000Z',
    providerDisplayName: 'Room One',
    resourceKey: 'calendar_1',
    startAt: '2026-09-01T10:00:00.000Z',
    timezone: 'UTC',
  },
  subject: { displayName: null },
};

function event(
  overrides: Partial<{
    readonly privateProperties: Readonly<Record<string, string>>;
    readonly status: string;
  }> = {},
) {
  return {
    end: request.slot.endAt,
    etag: '"etag-1"',
    id: googleEventId(bookingIntentId),
    privateProperties: {
      avenlyo_booking_intent_id: bookingIntentId,
      avenlyo_integration_id: 'integration_1',
      ...(overrides.privateProperties ?? {}),
    },
    resource: {
      end: { dateTime: request.slot.endAt },
      start: { dateTime: request.slot.startAt },
      summary: 'Consultation',
    },
    start: request.slot.startAt,
    status: overrides.status ?? 'confirmed',
  };
}

describe('Google Calendar connector identity', () => {
  it('derives a stable Google-compatible event ID from the booking intent UUID', () => {
    expect(googleEventId('6c0df1cb-2487-4e71-96b4-2e2667f4d2b1')).toBe(
      '6c0df1cb24874e7196b42e2667f4d2b1',
    );
    expect(googleEventId('6c0df1cb-2487-4e71-96b4-2e2667f4d2b1')).not.toBe(
      googleEventId('6c0df1cb-2487-4e71-96b4-2e2667f4d2b2'),
    );
  });

  it('does not manufacture a Google customer or subject identifier', async () => {
    const connector = new GoogleCalendarConnector(
      {} as ConstructorParameters<typeof GoogleCalendarConnector>[0],
    );
    await expect(
      connector.resolveBookingParty({
        subjectName: 'Max',
        trustedCallerE164: '+14155550123',
        trustedContactDisplayName: null,
        trustedContactId: 'contact_1',
      }),
    ).resolves.toEqual({
      kind: 'resolved',
      party: {
        customer: { displayName: null, providerKey: null, trustedPhoneE164: '+14155550123' },
        subject: { displayName: 'Max', providerKey: null },
      },
    });
  });

  it('permits an anonymous website visitor to use Google Calendar without treating a phone as verified', async () => {
    const connector = new GoogleCalendarConnector(
      {} as ConstructorParameters<typeof GoogleCalendarConnector>[0],
    );
    await expect(
      connector.resolveBookingParty({
        subjectName: null,
        trustedCallerE164: null,
        trustedContactDisplayName: null,
        trustedContactId: null,
      }),
    ).resolves.toEqual({
      kind: 'resolved',
      party: {
        customer: { displayName: 'Website visitor', providerKey: null, trustedPhoneE164: null },
        subject: { displayName: null, providerKey: null },
      },
    });
  });

  it('reconciles only the exact confirmed event with both trusted private markers', async () => {
    const getEvent = vi.fn().mockResolvedValue(event());
    const connector = new GoogleCalendarConnector({ getEvent } as unknown as GoogleCalendarClient);

    await expect(connector.reconcileBooking?.(request)).resolves.toEqual({
      appointment: { appointmentKey: googleEventId(bookingIntentId), providerStatus: 'confirmed' },
      kind: 'found',
    });
    expect(getEvent).toHaveBeenCalledWith('calendar_1', googleEventId(bookingIntentId));
  });

  it.each([
    ['cancelled event', event({ status: 'cancelled' })],
    [
      'wrong integration marker',
      event({ privateProperties: { avenlyo_integration_id: 'different-integration' } }),
    ],
  ])('does not accept a %s as a recovered booking success', async (_label, providerEvent) => {
    const connector = new GoogleCalendarConnector({
      getEvent: vi.fn().mockResolvedValue(providerEvent),
    } as unknown as GoogleCalendarClient);

    await expect(connector.reconcileBooking?.(request)).rejects.toMatchObject({
      category: 'provider_conflict',
    });
  });

  it('verifies markers then updates exactly once while preserving the event resource', async () => {
    const before = event();
    const after = { ...event(), end: '2026-09-01T11:30:00.000Z', start: '2026-09-01T11:00:00.000Z' };
    const updateEvent = vi.fn().mockResolvedValue(after);
    const connector = new GoogleCalendarConnector({ getEvent: vi.fn().mockResolvedValue(before), updateEvent } as unknown as GoogleCalendarClient);
    await expect(connector.rescheduleAppointment({ appointmentKey: before.id, bookingIntentId, integrationId: 'integration_1', originalEndAt: before.end, originalStartAt: before.start, resource: request.resource, targetEndAt: after.end, targetStartAt: after.start, timezone: 'UTC' })).resolves.toEqual({ kind: 'rescheduled', appointmentKey: before.id });
    expect(updateEvent).toHaveBeenCalledOnce();
    expect(updateEvent).toHaveBeenCalledWith('calendar_1', before.id, expect.objectContaining({ summary: 'Consultation', start: { dateTime: after.start, timeZone: 'UTC' } }), '"etag-1"');
  });

  it('does not treat a cancelled event at the requested replacement time as a successful reschedule recovery', async () => {
    const target = { ...event({ status: 'cancelled' }), end: '2026-09-01T11:30:00.000Z', start: '2026-09-01T11:00:00.000Z' };
    const connector = new GoogleCalendarConnector({ getEvent: vi.fn().mockResolvedValue(target) } as unknown as GoogleCalendarClient);
    await expect(connector.getAppointmentState({ appointmentKey: target.id, bookingIntentId, integrationId: 'integration_1', originalEndAt: request.slot.endAt, originalStartAt: request.slot.startAt, resource: request.resource, targetEndAt: target.end, targetStartAt: target.start, timezone: 'UTC' })).resolves.toEqual({ kind: 'ambiguous' });
  });

  it.each([
    ['timeout', new BookingProviderError('timeout')],
    ['network reset', new BookingProviderError('network')],
    ['HTTP 500', { body: {}, status: 500 }],
    ['HTTP 409', { body: {}, status: 409 }],
  ])('never blindly retries events.insert after a %s', async (_label, response) => {
    const transportRequest = vi.fn().mockImplementation(() => {
      if (response instanceof BookingProviderError) return Promise.reject(response);
      return Promise.resolve(response);
    });
    const client = new GoogleCalendarClient({
      accessToken: () => Promise.resolve('access-token'),
      transport: { request: transportRequest },
    });
    const connector = new GoogleCalendarConnector(client);

    await expect(connector.createBooking(request)).rejects.toBeInstanceOf(BookingProviderError);
    expect(transportRequest).toHaveBeenCalledOnce();
  });
});
