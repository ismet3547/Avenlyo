import { describe, expect, it, vi } from 'vitest';

import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

import {
  BusinessLocationSettingsError,
  updateBusinessSettings,
  updateLocationSettings,
} from './business-location-service';

function clientFor(result: { data: { id: string } | null; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const select = vi.fn(() => ({ maybeSingle }));
  const chain = {
    eq: vi.fn(),
    select,
  };
  chain.eq.mockReturnValue(chain);
  const update = vi.fn(() => chain);
  const from = vi.fn(() => ({ update }));

  return {
    client: { from } as unknown as AvenlyoSupabaseClient,
    from,
    update,
    eq: chain.eq,
  };
}

describe('business and location settings persistence', () => {
  it('updates only the trusted organization row with normalized business fields', async () => {
    const fake = clientFor({ data: { id: 'org-1' }, error: null });

    await updateBusinessSettings(fake.client, 'org-1', {
      name: 'Avenlyo Dental Clinic',
      phone: '+905551234567',
      websiteUrl: 'https://clinic.example',
    });

    expect(fake.from).toHaveBeenCalledWith('organizations');
    expect(fake.update).toHaveBeenCalledWith({
      business_phone: '+905551234567',
      name: 'Avenlyo Dental Clinic',
      website_url: 'https://clinic.example',
    });
    expect(fake.eq).toHaveBeenCalledWith('id', 'org-1');
  });

  it('scopes a location update to both trusted organization and location ids', async () => {
    const fake = clientFor({ data: { id: 'loc-1' }, error: null });
    const hours = {
      monday: { closed: false as const, open: '09:00', close: '18:00' },
      tuesday: { closed: false as const, open: '09:00', close: '18:00' },
      wednesday: { closed: false as const, open: '09:00', close: '18:00' },
      thursday: { closed: false as const, open: '09:00', close: '18:00' },
      friday: { closed: false as const, open: '09:00', close: '18:00' },
      saturday: { closed: false as const, open: '10:00', close: '15:00' },
      sunday: { closed: true as const, open: null, close: null },
    };

    await updateLocationSettings(fake.client, 'org-1', 'loc-1', {
      name: 'Istanbul Main Clinic',
      street: 'Clinic Street 1',
      city: 'Istanbul',
      region: 'Istanbul',
      postalCode: '34710',
      countryCode: 'TR',
      timezone: 'Europe/Istanbul',
      businessHours: hours,
    });

    expect(fake.from).toHaveBeenCalledWith('locations');
    expect(fake.eq).toHaveBeenNthCalledWith(1, 'organization_id', 'org-1');
    expect(fake.eq).toHaveBeenNthCalledWith(2, 'id', 'loc-1');
    expect(fake.update).toHaveBeenCalledWith(
      expect.objectContaining({
        business_hours: hours,
        name: 'Istanbul Main Clinic',
        timezone: 'Europe/Istanbul',
      }),
    );
  });

  it('fails closed when RLS no longer exposes the target row', async () => {
    const fake = clientFor({ data: null, error: null });

    await expect(
      updateBusinessSettings(fake.client, 'org-1', {
        name: 'Clinic',
        phone: undefined,
        websiteUrl: undefined,
      }),
    ).rejects.toBeInstanceOf(BusinessLocationSettingsError);
  });
});
