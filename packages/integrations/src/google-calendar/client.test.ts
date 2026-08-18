import { describe, expect, it, vi } from 'vitest';

import { GoogleCalendarClient } from './client';

function clientWithFreeBusy(body: unknown) {
  const request = vi.fn().mockResolvedValue({ body, status: 200 });
  return {
    client: new GoogleCalendarClient({
      accessToken: () => Promise.resolve('access-token'),
      transport: { request },
    }),
    request,
  };
}

const input = {
  calendarIds: ['calendar-a'],
  timeMax: '2026-09-01T12:00:00.000Z',
  timeMin: '2026-09-01T10:00:00.000Z',
  timeZone: 'UTC',
} as const;

describe('Google Calendar FreeBusy contract', () => {
  it('accepts an explicitly returned free calendar', async () => {
    const { client } = clientWithFreeBusy({ calendars: { 'calendar-a': { busy: [] } } });

    await expect(client.freeBusy(input)).resolves.toEqual(new Map([['calendar-a', []]]));
  });

  it('fails closed when Google omits a requested calendar', async () => {
    const { client } = clientWithFreeBusy({ calendars: {} });

    await expect(client.freeBusy(input)).rejects.toMatchObject({ category: 'provider_error' });
  });

  it.each(['notFound', 'internalError'])(
    'fails closed on a calendar-level %s error',
    async (reason) => {
      const { client } = clientWithFreeBusy({
        calendars: { 'calendar-a': { busy: [], errors: [{ reason }] } },
      });

      await expect(client.freeBusy(input)).rejects.toMatchObject({ category: 'provider_error' });
    },
  );

  it('does not treat a partial two-calendar response as available', async () => {
    const { client } = clientWithFreeBusy({
      calendars: {
        'calendar-a': { busy: [] },
        'calendar-b': { busy: [], errors: [{ reason: 'internalError' }] },
      },
    });

    await expect(
      client.freeBusy({ ...input, calendarIds: ['calendar-a', 'calendar-b'] }),
    ).rejects.toMatchObject({
      category: 'provider_error',
    });
  });
});

describe('Google Calendar lifecycle write contract', () => {
  const event = {
    end: { dateTime: '2026-09-01T10:30:00.000Z' },
    etag: '"etag-1"',
    extendedProperties: { private: { avenlyo_booking_intent_id: 'intent-1', avenlyo_integration_id: 'integration-1' } },
    id: 'event-1', start: { dateTime: '2026-09-01T10:00:00.000Z' }, status: 'confirmed', summary: 'Consultation',
  };

  it('uses one PUT with If-Match for a full-resource event update', async () => {
    const request = vi.fn().mockResolvedValue({ body: event, status: 200 });
    const client = new GoogleCalendarClient({ accessToken: () => Promise.resolve('token'), transport: { request } });
    await client.updateEvent('calendar-1', 'event-1', event, '"etag-1"');
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'PUT', headers: { Authorization: 'Bearer token', 'If-Match': '"etag-1"' } }));
  });

  it('uses one DELETE with If-Match and never retries it', async () => {
    const request = vi.fn().mockResolvedValue({ body: null, status: 204 });
    const client = new GoogleCalendarClient({ accessToken: () => Promise.resolve('token'), transport: { request } });
    await client.deleteEvent('calendar-1', 'event-1', '"etag-1"');
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', headers: { Authorization: 'Bearer token', 'If-Match': '"etag-1"' } }));
  });
});
