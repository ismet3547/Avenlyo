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
