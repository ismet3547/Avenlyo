import { describe, expect, it } from 'vitest';

import {
  businessDetailsSchema,
  businessHoursSchema,
  locationDetailsSchema,
  normalizePhoneNumber,
} from './onboarding';

const weekdayHours = {
  closed: false as const,
  open: '09:00',
  close: '17:00',
};

const validHours = {
  monday: weekdayHours,
  tuesday: weekdayHours,
  wednesday: weekdayHours,
  thursday: weekdayHours,
  friday: weekdayHours,
  saturday: { closed: true as const, open: null, close: null },
  sunday: { closed: true as const, open: null, close: null },
};

describe('onboarding validation', () => {
  it('normalizes business contact details and accepts HTTP websites', () => {
    expect(
      businessDetailsSchema.parse({
        name: '  North Star Vet  ',
        websiteUrl: 'https://northstar.example',
        phone: '+90 (555) 123 45 67',
      }),
    ).toEqual({
      name: 'North Star Vet',
      websiteUrl: 'https://northstar.example',
      phone: '+905551234567',
    });
    expect(normalizePhoneNumber('555-123-4567')).toBe('5551234567');
  });

  it('rejects non-HTTP websites and overnight hours', () => {
    expect(
      businessDetailsSchema.safeParse({ name: 'North Star', websiteUrl: 'ftp://example.com' })
        .success,
    ).toBe(false);

    expect(
      businessHoursSchema.safeParse({
        ...validHours,
        monday: { closed: false, open: '18:00', close: '09:00' },
      }).success,
    ).toBe(false);
  });

  it('validates ISO country codes and IANA timezones', () => {
    const result = locationDetailsSchema.parse({
      name: 'Main location',
      street: '123 Main Street',
      city: 'Istanbul',
      region: 'Istanbul',
      postalCode: '34000',
      countryCode: 'tr',
      timezone: 'Europe/Istanbul',
      businessHours: validHours,
    });

    expect(result.countryCode).toBe('TR');
  });
});
