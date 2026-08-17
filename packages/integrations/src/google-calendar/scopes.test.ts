import { describe, expect, it } from 'vitest';

import { GOOGLE_CALENDAR_SCOPES } from './scopes';

describe('Google Calendar OAuth scopes', () => {
  it('uses only the fixed least-privilege calendar scopes', () => {
    expect(GOOGLE_CALENDAR_SCOPES).toEqual([
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/calendar.events',
    ]);
  });
});
