import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { GoogleCalendarIntegrationService } from './google-calendar-service';

function service(rpc: ReturnType<typeof vi.fn>) {
  return new GoogleCalendarIntegrationService({
    clientId: 'client-id', clientSecret: 'client-secret', oauthRedirectUri: 'https://api.example.test/google/callback',
    supabase: { rpc } as unknown as SupabaseClient<Database>,
  });
}

describe('Google Calendar OAuth start', () => {
  it('uses an opaque one-time state, offline access, and the fixed scope set', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ location_id: 'location', organization_id: 'org' }], error: null });
    const url = new URL(await service(rpc).beginConnection('user', 'location'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toBe([
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/calendar.events',
    ].join(' '));
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const input = rpc.mock.calls[0]?.[1] as { target_state_hash: string };
    expect(input.target_state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(input.target_state_hash).not.toContain('location');
  });

  it('does not let a non-manager begin OAuth', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: { message: 'forbidden' } });
    await expect(service(rpc).beginConnection('member', 'location')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
