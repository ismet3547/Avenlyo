import { createHash, randomBytes } from 'node:crypto';

import {
  BookingProviderError,
  FetchGoogleCalendarTransport,
  GoogleCalendarClient,
  GoogleCalendarConnector,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_OAUTH_AUTHORIZE_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  type GoogleCalendarTransport,
} from '@avenlyo/integrations';
import type { Database, GoogleCalendarExecutionCredentialsRow } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

import { SchedulingServiceError } from './ezyvet-service.js';

interface GoogleTokenResponse {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly refreshToken: string | null;
}

function stateHash(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

function parseToken(value: unknown): GoogleTokenResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SchedulingServiceError();
  const row = value as Record<string, unknown>;
  const accessToken = typeof row.access_token === 'string' ? row.access_token : null;
  const expiresIn = typeof row.expires_in === 'number' ? row.expires_in : null;
  const refreshToken = typeof row.refresh_token === 'string' ? row.refresh_token : null;
  if (!accessToken || !expiresIn || expiresIn <= 0) throw new SchedulingServiceError();
  return { accessToken, expiresInSeconds: expiresIn, refreshToken };
}

function safeServiceError(error: unknown): SchedulingServiceError {
  if (error instanceof SchedulingServiceError) return error;
  if (error instanceof BookingProviderError && ['authentication', 'authorization_scope'].includes(error.category)) {
    return new SchedulingServiceError('Google Calendar could not authorize this connection.', 'VALIDATION');
  }
  return new SchedulingServiceError();
}

class GoogleAccessTokenCache {
  private readonly values = new Map<string, { readonly expiresAt: number; readonly value: string }>();

  public clear(integrationId: string): void { this.values.delete(integrationId); }
  public get(integrationId: string): string | null {
    const entry = this.values.get(integrationId);
    if (!entry || entry.expiresAt <= Date.now() + 60_000) { this.values.delete(integrationId); return null; }
    return entry.value;
  }
  public set(integrationId: string, token: GoogleTokenResponse): void {
    this.values.set(integrationId, { value: token.accessToken, expiresAt: Date.now() + token.expiresInSeconds * 1_000 });
  }
}

/** Trusted Fastify-only Google OAuth, Vault-token, discovery, and connector factory boundary. */
export class GoogleCalendarIntegrationService {
  public readonly provider = 'google_calendar' as const;
  private readonly accessTokens = new GoogleAccessTokenCache();

  public constructor(private readonly input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly oauthRedirectUri: string;
    readonly supabase: SupabaseClient<Database>;
    readonly transport?: GoogleCalendarTransport;
    readonly tokenRequest?: (form: URLSearchParams) => Promise<GoogleTokenResponse>;
  }) {}

  public async beginConnection(userId: string, locationId: string): Promise<string> {
    try {
      const state = randomBytes(32).toString('base64url');
      const { data, error } = await this.input.supabase.rpc('create_google_oauth_state', {
        target_location_id: locationId, target_state_hash: stateHash(state), target_user_id: userId,
      });
      if (error || !data[0]) throw new SchedulingServiceError('Only organization owners and admins can connect Google Calendar.', 'FORBIDDEN');
      const authorizationUrl = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
      authorizationUrl.searchParams.set('client_id', this.input.clientId);
      authorizationUrl.searchParams.set('redirect_uri', this.input.oauthRedirectUri);
      authorizationUrl.searchParams.set('response_type', 'code');
      authorizationUrl.searchParams.set('access_type', 'offline');
      authorizationUrl.searchParams.set('prompt', 'consent');
      authorizationUrl.searchParams.set('scope', GOOGLE_CALENDAR_SCOPES.join(' '));
      authorizationUrl.searchParams.set('state', state);
      return authorizationUrl.toString();
    } catch (error) { throw safeServiceError(error); }
  }

  public async completeConnection(code: string, state: string): Promise<void> {
    try {
      if (!code || !state) throw new SchedulingServiceError('Google authorization response is invalid.', 'VALIDATION');
      const { data, error } = await this.input.supabase.rpc('consume_google_oauth_state', { target_state_hash: stateHash(state) });
      const consumed = data?.[0];
      if (error || !consumed) throw new SchedulingServiceError('Google authorization has expired or was already used.', 'VALIDATION');
      const token = await this.exchangeCode(code);
      const client = this.clientForAccessToken(() => Promise.resolve(token.accessToken));
      const calendars = await this.listWritableCalendars(client);
      const { data: stored, error: storeError } = await this.input.supabase.rpc('store_google_calendar_connection', {
        target_location_id: consumed.location_id,
        target_organization_id: consumed.organization_id,
        target_refresh_token: token.refreshToken ?? '',
      });
      const integrationId = stored?.[0]?.integration_id;
      if (storeError || !integrationId) throw new SchedulingServiceError();
      this.accessTokens.clear(integrationId);
      const { error: saveError } = await this.input.supabase.rpc('save_google_calendar_resources', {
        calendars: calendars.map((calendar) => ({ access_role: calendar.accessRole, external_uid: calendar.id, name: calendar.summary, timezone: calendar.timeZone })),
        target_integration_id: integrationId,
      });
      if (saveError) throw new SchedulingServiceError();
    } catch (error) { throw safeServiceError(error); }
  }

  public async discover(userId: string, locationId: string): Promise<void> {
    try {
      const authorization = await this.authorize(userId, locationId);
      const integration = await this.integrationForLocation(authorization.organization_id, authorization.location_id);
      if (!integration || integration.status !== 'connected') throw new SchedulingServiceError('Connect Google Calendar first.', 'VALIDATION');
      const calendars = await this.listWritableCalendars(this.clientForIntegration(integration.integration_id));
      const { error } = await this.input.supabase.rpc('save_google_calendar_resources', {
        calendars: calendars.map((calendar) => ({ access_role: calendar.accessRole, external_uid: calendar.id, name: calendar.summary, timezone: calendar.timeZone })),
        target_integration_id: integration.integration_id,
      });
      if (error) throw new SchedulingServiceError();
    } catch (error) { throw safeServiceError(error); }
  }

  public async disconnect(userId: string, locationId: string): Promise<void> {
    try {
      const authorization = await this.authorize(userId, locationId);
      const integration = await this.integrationForLocation(authorization.organization_id, authorization.location_id);
      const { error } = await this.input.supabase.rpc('disable_google_calendar_integration', {
        target_location_id: authorization.location_id, target_organization_id: authorization.organization_id,
      });
      if (error) throw new SchedulingServiceError();
      if (integration) this.accessTokens.clear(integration.integration_id);
    } catch (error) { throw safeServiceError(error); }
  }

  public connectorForIntegration(integrationId: string): Promise<GoogleCalendarConnector> {
    return Promise.resolve(new GoogleCalendarConnector(this.clientForIntegration(integrationId)));
  }

  private async authorize(userId: string, locationId: string) {
    const { data, error } = await this.input.supabase.rpc('get_google_backend_authorization', { target_location_id: locationId, target_user_id: userId });
    if (error || !data[0]) throw new SchedulingServiceError('Only organization owners and admins can manage Google Calendar.', 'FORBIDDEN');
    return data[0];
  }

  private async integrationForLocation(organizationId: string, locationId: string) {
    const { data, error } = await this.input.supabase.rpc('get_google_calendar_integration_for_location', { target_location_id: locationId, target_organization_id: organizationId });
    if (error) throw new SchedulingServiceError();
    return data[0] ?? null;
  }

  private clientForIntegration(integrationId: string): GoogleCalendarClient {
    return this.clientForAccessToken(async () => this.accessToken(integrationId));
  }

  private clientForAccessToken(accessToken: () => Promise<string>): GoogleCalendarClient {
    return new GoogleCalendarClient({ accessToken, transport: this.input.transport ?? new FetchGoogleCalendarTransport() });
  }

  private async listWritableCalendars(client: GoogleCalendarClient) {
    const result = [] as Awaited<ReturnType<GoogleCalendarClient['calendarList']>>['items'][number][];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const response = await client.calendarList(pageToken);
      result.push(...response.items.filter((item) => item.accessRole === 'writer' || item.accessRole === 'owner'));
      if (!response.nextPageToken) break;
      pageToken = response.nextPageToken;
    }
    return result;
  }

  private async accessToken(integrationId: string): Promise<string> {
    const cached = this.accessTokens.get(integrationId);
    if (cached) return cached;
    const { data, error } = await this.input.supabase.rpc('get_google_calendar_execution_credentials', { target_integration_id: integrationId });
    const credentials: GoogleCalendarExecutionCredentialsRow | undefined = data?.[0];
    if (error || !credentials?.refresh_token) throw new SchedulingServiceError('Google Calendar credentials are not available.', 'NOT_CONFIGURED');
    const token = await this.refreshToken(credentials.refresh_token);
    this.accessTokens.set(integrationId, token);
    return token.accessToken;
  }

  private async exchangeCode(code: string): Promise<GoogleTokenResponse> {
    return this.requestToken(new URLSearchParams({
      client_id: this.input.clientId, client_secret: this.input.clientSecret, code,
      grant_type: 'authorization_code', redirect_uri: this.input.oauthRedirectUri,
    }));
  }

  private async refreshToken(refreshToken: string): Promise<GoogleTokenResponse> {
    return this.requestToken(new URLSearchParams({
      client_id: this.input.clientId, client_secret: this.input.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken,
    }));
  }

  private async requestToken(form: URLSearchParams): Promise<GoogleTokenResponse> {
    if (this.input.tokenRequest) return this.input.tokenRequest(form);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
      if (!response.ok) throw new BookingProviderError(response.status === 401 ? 'authentication' : 'provider_error');
      const payload: unknown = await response.json();
      return parseToken(payload);
    } catch (error) {
      if (error instanceof BookingProviderError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') throw new BookingProviderError('timeout');
      throw new BookingProviderError('network');
    } finally { clearTimeout(timer); }
  }
}
