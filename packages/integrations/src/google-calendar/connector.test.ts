import { describe, expect, it } from 'vitest';

import { GoogleCalendarConnector, googleEventId } from './connector';

describe('Google Calendar connector identity', () => {
  it('derives a stable Google-compatible event ID from the booking intent UUID', () => {
    expect(googleEventId('6c0df1cb-2487-4e71-96b4-2e2667f4d2b1')).toBe('6c0df1cb24874e7196b42e2667f4d2b1');
    expect(googleEventId('6c0df1cb-2487-4e71-96b4-2e2667f4d2b1')).not.toBe(
      googleEventId('6c0df1cb-2487-4e71-96b4-2e2667f4d2b2'),
    );
  });

  it('does not manufacture a Google customer or subject identifier', async () => {
    const connector = new GoogleCalendarConnector({} as ConstructorParameters<typeof GoogleCalendarConnector>[0]);
    await expect(connector.resolveBookingParty({
      subjectName: 'Max', trustedCallerE164: '+14155550123', trustedContactDisplayName: null, trustedContactId: 'contact_1',
    })).resolves.toEqual({
      kind: 'resolved', party: {
        customer: { displayName: null, providerKey: null, trustedPhoneE164: '+14155550123' },
        subject: { displayName: 'Max', providerKey: null },
      },
    });
  });
});
