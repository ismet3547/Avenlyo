import { TOKEN_EXPIRY_SAFETY_MS } from '../scheduling/limits';
import { BookingProviderError, providerErrorForStatus } from '../scheduling/errors';

import type { EzyVetCredentials, EzyVetTransport } from './types';

export const EZYVET_MINIMUM_SCOPES = [
  'read-appointment',
  'read-appointmenttype',
  'read-resource',
  'read-contact',
  'read-animal',
  'create-booking',
] as const;

interface CachedToken {
  readonly expiresAt: number;
  readonly value: string;
}

interface TokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToken(value: unknown): TokenResponse {
  if (
    !isRecord(value) ||
    typeof value.access_token !== 'string' ||
    value.access_token.length === 0 ||
    typeof value.expires_in !== 'number' ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0
  ) {
    throw new BookingProviderError('authentication');
  }
  return { access_token: value.access_token, expires_in: value.expires_in };
}

/** In-memory only; persisted integration credentials stay in Supabase Vault. */
export class EzyVetTokenCache {
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly values = new Map<string, CachedToken>();

  public clear(integrationId: string): void {
    this.values.delete(integrationId);
  }

  public async get(
    integrationId: string,
    credentials: EzyVetCredentials,
    partnerId: string,
    tokenUrl: string,
    transport: EzyVetTransport,
    now = Date.now(),
  ): Promise<string> {
    const cached = this.values.get(integrationId);
    if (cached && cached.expiresAt > now + TOKEN_EXPIRY_SAFETY_MS) return cached.value;

    const pending = this.inFlight.get(integrationId);
    if (pending) return pending;

    const issued = this.issue(
      integrationId,
      credentials,
      partnerId,
      tokenUrl,
      transport,
      now,
    ).finally(() => this.inFlight.delete(integrationId));
    this.inFlight.set(integrationId, issued);
    return issued;
  }

  private async issue(
    integrationId: string,
    credentials: EzyVetCredentials,
    partnerId: string,
    tokenUrl: string,
    transport: EzyVetTransport,
    now: number,
  ): Promise<string> {
    let response;
    try {
      response = await transport.request({
        body: {
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          grant_type: 'client_credentials',
          partner_id: partnerId,
          scope: EZYVET_MINIMUM_SCOPES.join(' '),
          site_uid: credentials.siteUid,
        },
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        timeoutMs: 8_000,
        url: tokenUrl,
      });
    } catch {
      throw new BookingProviderError('network');
    }
    if (response.status < 200 || response.status >= 300) throw providerErrorForStatus(response.status);
    const token = parseToken(response.body);
    this.values.set(integrationId, {
      expiresAt: now + token.expires_in * 1_000,
      value: token.access_token,
    });
    return token.access_token;
  }
}
