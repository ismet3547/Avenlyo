import { describe, expect, it } from 'vitest';

import { FakeEzyVetTransport } from '../testing/fake-ezyvet-transport';
import { EzyVetTokenCache, EZYVET_MINIMUM_SCOPES } from './auth';
import { EzyVetClient, ezyVetOrigins } from './client';
import { EzyVetConnector } from './connector';
import type { EzyVetCredentials } from './types';

const trialCredentials = {
  clientId: 'client_id',
  clientSecret: 'not-logged-secret',
  environment: 'trial' as const,
  siteUid: 'site_trial_1',
};
const productionCredentials = { ...trialCredentials, environment: 'production' as const };

function client(
  transport: FakeEzyVetTransport,
  credentials: EzyVetCredentials = trialCredentials,
  tokenCache = new EzyVetTokenCache(),
): EzyVetClient {
  return new EzyVetClient({
    credentials,
    integrationId: 'integration_1',
    partnerId: 'avenlyo_partner',
    tokenCache,
    transport,
    wait: () => Promise.resolve(),
  });
}

const siteInformation = {
  data: {
    id: 'site_trial_1',
    relationships: { timezone: { data: { id: '94', type: 'timezone' } } },
  },
  included: [{ attributes: { name: 'Pacific/Auckland' }, id: '94', type: 'timezone' }],
};

describe('ezyVet connector contracts', () => {
  it('keeps Core, token, and documented ezyCAB origins intentionally separate', () => {
    expect(ezyVetOrigins('production')).toEqual({
      coreApiOrigin: 'https://api.ezyvet.com',
      ezyCabOrigin: 'https://apiv2.ezyvet.com',
      tokenOrigin: 'https://api.ezyvet.com/v1/oauth/access_token',
    });
    expect(ezyVetOrigins('trial')).toEqual({
      coreApiOrigin: 'https://api.trial.ezyvet.com',
      ezyCabOrigin: null,
      tokenOrigin: 'https://api.trial.ezyvet.com/v1/oauth/access_token',
    });
  });

  it('uses the documented client credentials and exactly the required booking scopes', async () => {
    const transport = new FakeEzyVetTransport();
    transport.enqueue({ body: { access_token: 'token_1', expires_in: 3_600 }, status: 200 });
    transport.enqueue({ body: siteInformation, status: 200 });
    await expect(new EzyVetConnector(client(transport)).getSite()).resolves.toEqual({
      id: 'site_trial_1',
      timezone: 'Pacific/Auckland',
    });
    expect(transport.requests[0]).toMatchObject({
      body: {
        client_id: 'client_id',
        grant_type: 'client_credentials',
        partner_id: 'avenlyo_partner',
        scope: EZYVET_MINIMUM_SCOPES.join(' '),
        site_uid: 'site_trial_1',
      },
      url: 'https://api.trial.ezyvet.com/v1/oauth/access_token',
    });
    expect(EZYVET_MINIMUM_SCOPES).not.toContain('read-contact');
    expect(transport.requests[1]?.url).toBe('https://api.trial.ezyvet.com/v3/siteInformation');
  });

  it.each([
    { ...siteInformation, data: { id: 'site_trial_1', relationships: {} } },
    {
      ...siteInformation,
      included: [{ attributes: { name: 'Not/A-Timezone' }, id: '94', type: 'timezone' }],
    },
    { ...siteInformation, included: [{ attributes: { name: 'UTC' }, id: '95', type: 'timezone' }] },
  ])('rejects malformed JSON:API site information', async (payload) => {
    const transport = new FakeEzyVetTransport();
    transport.enqueue({ body: { access_token: 'token_1', expires_in: 3_600 }, status: 200 });
    transport.enqueue({ body: payload, status: 200 });
    await expect(new EzyVetConnector(client(transport)).getSite()).rejects.toThrow(
      'site information was incomplete or invalid',
    );
  });

  it('uses Core direct queries for catalog, exact contact detail, and UID-safe animals', async () => {
    const transport = new FakeEzyVetTransport();
    transport.enqueue({ body: { access_token: 'token_1', expires_in: 3_600 }, status: 200 });
    transport.enqueue({ body: siteInformation, status: 200 });
    transport.enqueue({
      body: {
        items: [
          {
            appointmenttype: {
              active: true,
              default_duration: 30,
              name: 'Wellness',
              uid: 'type_1',
            },
          },
        ],
      },
      status: 200,
    });
    transport.enqueue({
      body: {
        items: [
          {
            resource: {
              access: 'On Calendar',
              active: true,
              name: 'Dr Ray',
              ownership_id: 'sep_1',
              uid: 'resource_1',
            },
          },
        ],
      },
      status: 200,
    });
    const connector = new EzyVetConnector(client(transport));
    await connector.getSchedulingCatalog();
    expect(transport.requests.map((request) => request.url)).toContain(
      'https://api.trial.ezyvet.com/v2/appointmenttype?active=true',
    );
    expect(transport.requests.map((request) => request.url)).toContain(
      'https://api.trial.ezyvet.com/v2/resource?access=On+Calendar&active=true',
    );

    transport.enqueue({
      body: {
        items: [
          {
            contactdetail: { active: true, contact_uid: 'contact_1', value_cleaned: '14155550199' },
          },
        ],
      },
      status: 200,
    });
    transport.enqueue({
      body: {
        data: [{ id: 'animal_1', name: 'Max', ownerId: 'contact_1' }],
      },
      status: 200,
    });
    const customer = await connector.resolveCustomer({ trustedCallerE164: '+14155550199' });
    if (customer.kind !== 'resolved') throw new Error('Expected exact customer match.');
    await expect(
      connector.resolveSubject({ customer: customer.customer, petName: ' Max ' }),
    ).resolves.toMatchObject({ kind: 'resolved', subject: { key: 'animal_1' } });
    expect(transport.requests.at(-2)?.url).toBe(
      'https://api.trial.ezyvet.com/v2/contactdetail?value_cleaned=14155550199',
    );
    expect(transport.requests.at(-1)?.url).toBe(
      'https://api.trial.ezyvet.com/v4/animal?isDead=false&name=Max&ownerId=contact_1&status=active',
    );
  });

  it('keeps only durations ezyCAB can schedule', async () => {
    const transport = new FakeEzyVetTransport();
    transport.enqueue({ body: { access_token: 'token_1', expires_in: 3_600 }, status: 200 });
    transport.enqueue({ body: siteInformation, status: 200 });
    transport.enqueue({
      body: {
        items: [10, 30, 360, 365, 480, 17].map((default_duration) => ({
          appointmenttype: {
            active: true,
            default_duration,
            name: String(default_duration),
            uid: `type_${default_duration}`,
          },
        })),
      },
      status: 200,
    });
    transport.enqueue({ body: { items: [] }, status: 200 });
    await expect(
      new EzyVetConnector(client(transport)).getSchedulingCatalog(),
    ).resolves.toMatchObject({
      appointmentTypes: [
        { defaultDurationMinutes: 10, key: 'type_10' },
        { defaultDurationMinutes: 30, key: 'type_30' },
        { defaultDurationMinutes: 360, key: 'type_360' },
      ],
    });
  });

  it('rejects a booking call in a trial environment without inventing a trial ezyCAB host', async () => {
    await expect(
      client(new FakeEzyVetTransport()).postEzyCab('/ezycab/booking', {}),
    ).rejects.toMatchObject({
      category: 'invalid_request',
    });
  });

  it('parses ezyCAB availability, splits 14 days into two seven-day requests, and deduplicates slots', async () => {
    const transport = new FakeEzyVetTransport();
    transport.enqueue({ body: { access_token: 'token_1', expires_in: 3_600 }, status: 200 });
    const payload = {
      data: [
        {
          attributes: {
            date: '2026-09-01',
            timezone: 'America/New_York',
            slots: [
              {
                available: true,
                duration: 30,
                relationships: { appointmentType: { data: [{ id: 'type_1' }] } },
                start: '2025-07-14T09:30:00.000-04:00',
              },
            ],
          },
          relationships: { resource: { id: 'resource_1' } },
        },
      ],
    };
    transport.enqueue({ body: payload, status: 200 });
    transport.enqueue({ body: payload, status: 200 });
    const connector = new EzyVetConnector(client(transport, productionCredentials));
    const slots = await connector.getAvailability({
      appointmentType: { defaultDurationMinutes: 30, key: 'type_1', name: 'Wellness' },
      dates: Array.from(
        { length: 14 },
        (_, index) => `2026-09-${String(index + 1).padStart(2, '0')}`,
      ),
      resources: [{ key: 'resource_1', name: 'Dr Ray', schedulingScopeKey: 'sep_1' }],
      timezone: 'America/New_York',
    });
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      endAt: '2025-07-14T14:00:00.000Z',
      startAt: '2025-07-14T13:30:00.000Z',
    });
    expect(
      transport.requests.filter((request) => request.url.includes('/ezycab/availability')),
    ).toHaveLength(2);
    expect(transport.requests.every((request) => !request.url.includes('not-logged-secret'))).toBe(
      true,
    );
  });

  it('normalizes a winter ISO offset and rejects a provider timezone mismatch', async () => {
    const transport = new FakeEzyVetTransport();
    transport.enqueue({ body: { access_token: 'token_1', expires_in: 3_600 }, status: 200 });
    transport.enqueue({
      body: {
        data: [
          {
            attributes: {
              date: '2025-01-14',
              timezone: 'America/New_York',
              slots: [
                {
                  available: true,
                  duration: 30,
                  relationships: { appointmentType: { data: [{ id: 'type_1' }] } },
                  start: '2025-01-14T09:30:00.000-05:00',
                },
              ],
            },
            relationships: { resource: { id: 'resource_1' } },
          },
        ],
      },
      status: 200,
    });
    const connector = new EzyVetConnector(client(transport, productionCredentials));
    await expect(
      connector.getAvailability({
        appointmentType: { defaultDurationMinutes: 30, key: 'type_1', name: 'Wellness' },
        dates: ['2025-01-14'],
        resources: [{ key: 'resource_1', name: 'Dr Ray', schedulingScopeKey: 'sep_1' }],
        timezone: 'America/New_York',
      }),
    ).resolves.toMatchObject([{ startAt: '2025-01-14T14:30:00.000Z' }]);
  });

  it('posts once to ezyCAB and reconciles only an exact active appointment within its narrow resource/start range', async () => {
    const transport = new FakeEzyVetTransport();
    transport.enqueue({ body: { access_token: 'token_1', expires_in: 3_600 }, status: 200 });
    transport.enqueue({ body: { appointment: 'appointment_1' }, status: 201 });
    transport.enqueue({
      body: {
        meta: { nextToken: null },
        data: [
          {
            active: true,
            animal_uid: 'animal_1',
            contact_uid: 'contact_1',
            id: 12346,
            resources: [{ name: 'Dr Ray', type: 'user', uid: 'resource_1' }],
            start_at: 1788256800,
            type_uid: 'type_1',
            uid: 'appointment_1',
          },
        ],
      },
      status: 200,
    });
    const connector = new EzyVetConnector(client(transport, productionCredentials));
    const request = {
      appointmentType: { defaultDurationMinutes: 30, key: 'type_1', name: 'Wellness' },
      customer: { displayName: null, key: 'contact_1' },
      description: 'Booked through Avenlyo.',
      resource: { key: 'resource_1', name: 'Dr Ray', schedulingScopeKey: 'scope_1' },
      slot: {
        appointmentTypeKey: 'type_1',
        endAt: '2026-09-01T10:30:00.000Z',
        providerDisplayName: 'Dr Ray',
        resourceKey: 'resource_1',
        startAt: '2026-09-01T10:00:00.000Z',
        timezone: 'UTC',
      },
      subject: { displayName: 'Max', key: 'animal_1' },
    } as const;
    await expect(connector.createBooking(request)).resolves.toMatchObject({
      appointmentKey: 'appointment_1',
    });
    await expect(connector.reconcileBooking(request)).resolves.toMatchObject({ kind: 'found' });
    expect(transport.requests[1]?.url).toBe('https://apiv2.ezyvet.com/ezycab/booking');
    expect(transport.requests[2]?.url).toBe(
      'https://apiv2.ezyvet.com/ezycab/v2.1/appointments?filter%5Bactive%5D%5Beq%5D=true&filter%5Bresources.uid%5D%5Bin%5D=%5B%22resource_1%22%5D&filter%5Bstart_at%5D%5Bgte%5D=2026-09-01T09%3A59%3A00.000Z&filter%5Bstart_at%5D%5Blte%5D=2026-09-01T10%3A01%3A00.000Z&pageSize=50',
    );
  });
});
