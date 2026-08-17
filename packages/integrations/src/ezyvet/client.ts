import { BookingProviderError, providerErrorForStatus } from '../scheduling/errors';
import { PROVIDER_REQUEST_TIMEOUT_MS, SAFE_GET_MAX_ATTEMPTS } from '../scheduling/limits';

import type { EzyVetTokenCache } from './auth';
import type {
  EzyVetCredentials,
  EzyVetEnvironment,
  EzyVetTransport,
  EzyVetTransportResponse,
} from './types';

export interface EzyVetEndpointOrigins {
  readonly tokenOrigin: string;
  readonly coreApiOrigin: string;
  /** Null means ezyVet has not documented ezyCAB support for this environment. */
  readonly ezyCabOrigin: string | null;
}

const ORIGINS: Record<EzyVetEnvironment, EzyVetEndpointOrigins> = {
  production: {
    coreApiOrigin: 'https://api.ezyvet.com',
    ezyCabOrigin: 'https://apiv2.ezyvet.com',
    tokenOrigin: 'https://api.ezyvet.com/v1/oauth/access_token',
  },
  trial: {
    coreApiOrigin: 'https://api.trial.ezyvet.com',
    ezyCabOrigin: null,
    tokenOrigin: 'https://api.trial.ezyvet.com/v1/oauth/access_token',
  },
};

export function ezyVetOrigins(environment: EzyVetEnvironment) {
  return ORIGINS[environment];
}

export class FetchEzyVetTransport implements EzyVetTransport {
  public async request(input: {
    readonly body?: Readonly<Record<string, unknown>>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method: 'GET' | 'POST';
    readonly timeoutMs: number;
    readonly url: string;
  }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetch(input.url, {
        method: input.method,
        signal: controller.signal,
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        ...(input.headers ? { headers: { ...input.headers } } : {}),
      });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = null;
        }
      }
      return { body, status: response.status };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new BookingProviderError('timeout');
      }
      throw new BookingProviderError('network');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class EzyVetClient {
  public constructor(
    private readonly input: {
      readonly credentials: EzyVetCredentials;
      readonly integrationId: string;
      readonly partnerId: string;
      readonly tokenCache: EzyVetTokenCache;
      readonly transport: EzyVetTransport;
      readonly wait?: (milliseconds: number) => Promise<void>;
    },
  ) {}

  public clearToken(): void {
    this.input.tokenCache.clear(this.input.integrationId);
  }

  public supportsEzyCab(): boolean {
    return ezyVetOrigins(this.input.credentials.environment).ezyCabOrigin !== null;
  }

  public async getCore(
    path: string,
    params: Readonly<Record<string, string | readonly string[]>> = {},
  ) {
    return this.request(
      'GET',
      ezyVetOrigins(this.input.credentials.environment).coreApiOrigin,
      path,
      undefined,
      params,
      true,
    );
  }

  public async getEzyCab(
    path: string,
    params: Readonly<Record<string, string | readonly string[]>> = {},
  ) {
    return this.request('GET', this.ezyCabOrigin(), path, undefined, params, true);
  }

  public async postEzyCab(path: string, body: Readonly<Record<string, unknown>>) {
    return this.request('POST', this.ezyCabOrigin(), path, body, {}, false);
  }

  private async request(
    method: 'GET' | 'POST',
    origin: string,
    path: string,
    body: Readonly<Record<string, unknown>> | undefined,
    params: Readonly<Record<string, string | readonly string[]>>,
    canRetry: boolean,
  ): Promise<unknown> {
    const endpoint = new URL(path, origin);
    for (const [name, value] of Object.entries(params)) {
      for (const item of typeof value === 'string' ? [value] : value) {
        endpoint.searchParams.append(name, item);
      }
    }

    let refreshed = false;
    const attempts = canRetry ? SAFE_GET_MAX_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const token = await this.input.tokenCache.get(
        this.input.integrationId,
        this.input.credentials,
        this.input.partnerId,
        ezyVetOrigins(this.input.credentials.environment).tokenOrigin,
        this.input.transport,
      );
      let response: EzyVetTransportResponse;
      try {
        response = await this.input.transport.request({
          ...(body ? { body } : {}),
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          method,
          timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
          url: endpoint.toString(),
        });
      } catch (error) {
        const providerError =
          error instanceof BookingProviderError ? error : new BookingProviderError('network');
        if (canRetry && providerError.retryable && attempt + 1 < attempts) {
          await this.backoff(attempt);
          continue;
        }
        throw providerError;
      }
      if (response.status >= 200 && response.status < 300) return response.body;
      if (response.status === 401 && canRetry && !refreshed) {
        refreshed = true;
        this.clearToken();
        continue;
      }
      const error = providerErrorForStatus(response.status, method === 'POST');
      if (canRetry && error.retryable && attempt + 1 < attempts) {
        await this.backoff(attempt);
        continue;
      }
      throw error;
    }
    throw new BookingProviderError('provider_error');
  }

  private ezyCabOrigin(): string {
    const origin = ezyVetOrigins(this.input.credentials.environment).ezyCabOrigin;
    if (!origin) {
      throw new BookingProviderError(
        'invalid_request',
        'ezyCAB is not documented for the configured ezyVet environment.',
      );
    }
    return origin;
  }

  private async backoff(attempt: number): Promise<void> {
    const jitter = Math.floor(Math.random() * 100);
    const milliseconds = 150 * 2 ** attempt + jitter;
    if (this.input.wait) return this.input.wait(milliseconds);
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}
