import { describe, expect, it } from 'vitest';

import type { BookingProviderError } from '../scheduling/errors';
import { EzyVetTokenCache } from './auth';
import { EzyVetClient, ezyVetOrigins } from './client';
import { EzyVetConnector } from './connector';
import { FakeEzyVetTransport } from '../testing/fake-ezyvet-transport';

const credentials = {
  clientId: 'client_id',
  clientSecret: 'not-logged-secret',
  environment: 'trial' as const,
  siteUid: 'site_trial_1',
};

function client(transport: FakeEzyVetTransport, tokenCache = new EzyVetTokenCache()): EzyVetClient {
  return new EzyVetClient({
    credentials,
    integrationId: 'integration_1',
    partnerId: 'avenlyo_partner',
    tokenCache,
    transport,
    wait: () => Promise.resolve(),
  });
}

describe('ezyVet connector', () => {
  it('uses the documented client-credentials fields, fixed scopes, and site UID', async () => {
    const transport = new FakeEzyVetTransport();
    transport.enqueue({ body: { access_token: 'token_1', expires_in: 3_600 }, status: 200 });
    transport.enqueue({
      body: { siteInformation: { id: 'site_trial_1', timezone: 'Pacific/Auckland' } },
      status: 200,
    });

    await expect(new EzyVetConnector(client(transport)).getSite()).resolves.toEqual({
      id: 'site_trial_1',
      timezone: 'Pacific/Auckland',
    });

    const tokenRequest = transport.requests[0]!;
    expect(tokenRequest.url).toBe('https://api.trial.ezyvet.com/v1/oauth/access_token');
    expect(tokenRequest.body).toMatchObject({
      client_id: 'client_id',
      grant_type: 'client_credentials',
      partner_id: 'avenlyo_partner',
      site_uid: 'site_trial_1',
    });
    expect(String(tokenRequest.body?.scope)).toContain('create-booking');
    expect(String(tokenRequest.body?.scope)).toContain('read-animal');
    expect(transport.requests[1]!.url).toBe('https://api.trial.ezyvet.com/v3/siteInformation');
  });

  it('caches tokens, refreshes an expired cache entry, and retries one safe GET after 401', async () => {
    const transport = new FakeEzyVetTransport();
    const cache = new EzyVetTokenCache();
    transport.enqueue({ body: { access_token: 'token_1', expires_in: 61 }, status: 200 });
    transport.enqueue({ body: { site: { uid: 'site_trial_1', timezone: 'UTC' } }, status: 200 });
    transport.enqueue({ body: { site: { uid: 'site_trial_1', timezone: 'UTC' } }, status: 200 });
    const connector = new EzyVetConnector(client(transport, cache));

    await connector.getSite();
    await connector.getSite();
    expect(
      transport.requests.filter((request) => request.url.includes('access_token')),
    ).toHaveLength(1);

    transport.enqueue({ body: null, status: 401 });
    transport.enqueue({ body: { access_token: 'token_2', expires_in: 3_600 }, status: 200 });
    transport.enqueue({ body: { site: { uid: 'site_trial_1', timezone: 'UTC' } }, status: 200 });
    await connector.getSite();
    expect(
      transport.requests.filter((request) => request.url.includes('access_token')),
    ).toHaveLength(2);
  });

  it('normalizes catalog entries and excludes inactive or non-calendar resources', async () => {
    const transport = new FakeEzyVetTransport();
    transport.enqueue({ body: { access_token: 'token_1', expires_in: 3_600 }, status: 200 });
    transport.enqueue({ body: { site: { uid: 'site_trial_1', timezone: 'UTC' } }, status: 200 });
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
          {
            appointmenttype: {
              active: true,
              default_duration: 5,
              name: 'Too short',
              uid: 'type_2',
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
          {
            resource: {
              access: 'Off Calendar',
              active: true,
              name: 'Hidden',
              ownership_id: 'sep_1',
              uid: 'resource_2',
            },
          },
          {
            resource: {
              access: 'On Calendar',
              active: false,
              name: 'Inactive',
              ownership_id: 'sep_1',
              uid: 'resource_3',
            },
          },
        ],
      },
      status: 200,
    });

    await expect(new EzyVetConnector(client(transport)).getSchedulingCatalog()).resolves.toEqual({
      appointmentTypes: [{ defaultDurationMinutes: 30, key: 'type_1', name: 'Wellness' }],
      resources: [{ key: 'resource_1', name: 'Dr Ray', schedulingScopeKey: 'sep_1' }],
      site: { id: 'site_trial_1', timezone: 'UTC' },
    });
  });

  it('resolves only one exact customer and one active animal owned by that customer', async () => {
    const transport = new FakeEzyVetTransport();
    transport.enqueue({ body: { access_token: 'token_1', expires_in: 3_600 }, status: 200 });
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
        items: [
          { animal: { active: true, contact_uid: 'contact_1', name: 'Max', uid: 'animal_1' } },
          {
            animal: {
              active: true,
              contact_uid: 'contact_other',
              name: 'Max',
              uid: 'animal_wrong_owner',
            },
          },
        ],
      },
      status: 200,
    });
    const connector = new EzyVetConnector(client(transport));
    const customer = await connector.resolveCustomer({ trustedCallerE164: '+14155550199' });
    expect(customer).toMatchObject({ kind: 'resolved', customer: { key: 'contact_1' } });
    if (customer.kind !== 'resolved') throw new Error('Expected customer resolution.');
    await expect(
      connector.resolveSubject({ customer: customer.customer, petName: '  max ' }),
    ).resolves.toEqual({
      kind: 'resolved',
      subject: { displayName: 'Max', key: 'animal_1' },
    });
  });

  it('never uses an arbitrary customer API origin or leaks invalid credential details', async () => {
    expect(ezyVetOrigins('production')).toEqual({
      api: 'https://apiv2.ezyvet.com',
      token: 'https://api.ezyvet.com/v1/oauth/access_token',
    });
    const transport = new FakeEzyVetTransport();
    transport.enqueue({ body: { error: 'invalid_client' }, status: 401 });
    await expect(new EzyVetConnector(client(transport)).getSite()).rejects.toMatchObject({
      category: 'authentication',
    } satisfies Partial<BookingProviderError>);
    expect(transport.requests.every((request) => !request.url.includes('not-logged-secret'))).toBe(
      true,
    );
  });

  it('posts a confirmed immutable payload once and reconciles only a unique exact provider record', async () => {
    const transport = new FakeEzyVetTransport();
    transport.enqueue({ body: { access_token: 'token_1', expires_in: 3_600 }, status: 200 });
    transport.enqueue({ body: { appointment: 'appointment_1' }, status: 201 });
    transport.enqueue({
      body: {
        items: [
          {
            appointment: {
              animal_uid: 'animal_1',
              contact_uid: 'contact_1',
              provider_uid: 'resource_1',
              start_time: '2026-09-01T10:00:00.000Z',
              type: 'type_1',
              uid: 'appointment_1',
            },
          },
        ],
      },
      status: 200,
    });
    const connector = new EzyVetConnector(client(transport));
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
    expect(transport.requests[1]?.url).toBe('https://api.trial.ezyvet.com/ezycab/booking');
    expect(transport.requests[1]?.body).toMatchObject({
      animal: 'animal_1',
      appointmentStatus: 'unconfirmed',
      contact: 'contact_1',
      provider: 'resource_1',
      type: 'type_1',
    });
    await expect(connector.reconcileBooking(request)).resolves.toMatchObject({
      appointment: { appointmentKey: 'appointment_1' },
      kind: 'found',
    });
  });
});
