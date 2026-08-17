import {
  BookingProviderError,
  EzyVetClient,
  EzyVetConnector,
  EzyVetTokenCache,
  FetchEzyVetTransport,
  type EzyVetCredentials,
  type EzyVetEnvironment,
  type EzyVetTransport,
} from '@avenlyo/integrations';
import type { Database, EzyVetExecutionCredentialsRow } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface EzyVetConnectionInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly environment: EzyVetEnvironment;
  readonly siteUid: string;
}

export class SchedulingServiceError extends Error {
  public constructor(
    message = 'Scheduling could not be completed. Please try again or contact the clinic team.',
    public readonly code: 'FORBIDDEN' | 'NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE' | 'VALIDATION' =
      'PROVIDER_UNAVAILABLE',
  ) {
    super(message);
    this.name = 'SchedulingServiceError';
  }
}

function toServiceError(error: unknown): SchedulingServiceError {
  if (error instanceof SchedulingServiceError) return error;
  if (error instanceof BookingProviderError) {
    if (error.category === 'authentication' || error.category === 'authorization_scope') {
      return new SchedulingServiceError(
        'ezyVet could not verify these credentials. Check the connection details and required scopes.',
        'VALIDATION',
      );
    }
    if (error.category === 'invalid_request') {
      return new SchedulingServiceError('The ezyVet connection details are invalid.', 'VALIDATION');
    }
  }
  return new SchedulingServiceError();
}

function credentials(row: EzyVetExecutionCredentialsRow): EzyVetCredentials {
  if (row.environment !== 'production' && row.environment !== 'trial') {
    throw new SchedulingServiceError('ezyVet environment is invalid.', 'VALIDATION');
  }
  return {
    clientId: row.client_id,
    clientSecret: row.client_secret,
    environment: row.environment,
    siteUid: row.site_uid,
  };
}

/** Trusted Fastify-only connection and catalog service. It never returns credentials or raw errors. */
export class EzyVetIntegrationService {
  private readonly tokenCache = new EzyVetTokenCache();

  public constructor(
    private readonly input: {
      readonly partnerId: string;
      readonly supabase: SupabaseClient<Database>;
      readonly transport?: EzyVetTransport;
    },
  ) {}

  public async connect(
    userId: string,
    locationId: string,
    input: EzyVetConnectionInput,
  ): Promise<{ readonly integrationId: string; readonly timezone: string }> {
    try {
      this.validateConnectionInput(input);
      const authorization = await this.authorize(userId, locationId);
      const connector = this.connector(
        `preflight:${authorization.organization_id}:${locationId}`,
        input,
      );
      const site = await connector.getSite();
      if (site.id !== input.siteUid) {
        throw new SchedulingServiceError(
          'The supplied site UID does not match the connected ezyVet site.',
          'VALIDATION',
        );
      }
      const { data, error } = await this.input.supabase.rpc('store_ezyvet_connection', {
        target_client_id: input.clientId,
        target_client_secret: input.clientSecret,
        target_environment: input.environment,
        target_location_id: authorization.location_id,
        target_organization_id: authorization.organization_id,
        target_provider_site_id: site.id,
        target_provider_timezone: site.timezone,
        target_site_uid: input.siteUid,
      });
      const integrationId = data?.[0]?.integration_id;
      if (error || !integrationId) throw new SchedulingServiceError();
      this.tokenCache.clear(`preflight:${authorization.organization_id}:${locationId}`);
      return { integrationId, timezone: site.timezone };
    } catch (error) {
      throw toServiceError(error);
    }
  }

  public async disconnect(userId: string, locationId: string): Promise<void> {
    try {
      const authorization = await this.authorize(userId, locationId);
      const { error } = await this.input.supabase.rpc('disable_ezyvet_integration', {
        target_location_id: authorization.location_id,
        target_organization_id: authorization.organization_id,
      });
      if (error) throw new SchedulingServiceError();
      const integration = await this.integrationForLocation(authorization.organization_id, locationId);
      if (integration?.integration_id) this.tokenCache.clear(integration.integration_id);
    } catch (error) {
      throw toServiceError(error);
    }
  }

  public async syncCatalog(userId: string, locationId: string): Promise<void> {
    try {
      const authorization = await this.authorize(userId, locationId);
      const integration = await this.integrationForLocation(
        authorization.organization_id,
        authorization.location_id,
      );
      if (!integration?.integration_id || integration.status !== 'connected') {
        throw new SchedulingServiceError('Connect ezyVet before syncing its scheduling catalog.', 'VALIDATION');
      }
      const connector = await this.connectorForIntegration(integration.integration_id);
      const catalog = await connector.getSchedulingCatalog();
      const { error } = await this.input.supabase.rpc('save_ezyvet_catalog', {
        appointment_types: catalog.appointmentTypes.map((appointmentType) => ({
          active: true,
          default_duration_minutes: appointmentType.defaultDurationMinutes,
          external_uid: appointmentType.key,
          name: appointmentType.name,
        })),
        resources: catalog.resources.flatMap((resource) =>
          resource.schedulingScopeKey
            ? [
                {
                  active: true,
                  external_ownership_id: resource.schedulingScopeKey,
                  external_uid: resource.key,
                  name: resource.name,
                },
              ]
            : [],
        ),
        target_integration_id: integration.integration_id,
        target_site_timezone: catalog.site.timezone,
      });
      if (error) throw new SchedulingServiceError();
    } catch (error) {
      throw toServiceError(error);
    }
  }

  public async connectorForIntegration(integrationId: string): Promise<EzyVetConnector> {
    const { data, error } = await this.input.supabase.rpc('get_ezyvet_execution_credentials', {
      target_integration_id: integrationId,
    });
    const credential = data?.[0];
    if (error || !credential) {
      throw new SchedulingServiceError('ezyVet credentials are not available.', 'NOT_CONFIGURED');
    }
    return this.connector(integrationId, credentials(credential));
  }

  private async authorize(userId: string, locationId: string) {
    const { data, error } = await this.input.supabase.rpc('get_ezyvet_backend_authorization', {
      target_location_id: locationId,
      target_user_id: userId,
    });
    const authorization = data?.[0];
    if (error || !authorization) {
      throw new SchedulingServiceError(
        'Only organization owners and admins can configure ezyVet scheduling.',
        'FORBIDDEN',
      );
    }
    return authorization;
  }

  private connector(integrationId: string, input: EzyVetCredentials): EzyVetConnector {
    return new EzyVetConnector(
      new EzyVetClient({
        credentials: input,
        integrationId,
        partnerId: this.input.partnerId,
        tokenCache: this.tokenCache,
        transport: this.input.transport ?? new FetchEzyVetTransport(),
      }),
    );
  }

  private async integrationForLocation(organizationId: string, locationId: string) {
    const { data, error } = await this.input.supabase.rpc('get_ezyvet_integration_for_location', {
      target_location_id: locationId,
      target_organization_id: organizationId,
    });
    if (error) throw new SchedulingServiceError();
    return data?.[0] ?? null;
  }

  private validateConnectionInput(input: EzyVetConnectionInput): void {
    if (
      input.clientId.trim().length === 0 ||
      input.clientId.length > 500 ||
      input.clientSecret.trim().length === 0 ||
      input.clientSecret.length > 2_000 ||
      input.siteUid.trim().length === 0 ||
      input.siteUid.length > 500
    ) {
      throw new SchedulingServiceError('Enter valid ezyVet connection details.', 'VALIDATION');
    }
  }
}
