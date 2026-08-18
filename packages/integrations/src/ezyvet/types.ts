import type { SchedulingCatalog } from '../scheduling/types';

export type EzyVetEnvironment = 'production' | 'trial';

export interface EzyVetCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly environment: EzyVetEnvironment;
  readonly siteUid: string;
}

export interface EzyVetTransportRequest {
  readonly body?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: 'GET' | 'PATCH' | 'POST';
  readonly timeoutMs: number;
  readonly url: string;
}

export interface EzyVetTransportResponse {
  readonly body: unknown;
  readonly status: number;
}

export interface EzyVetTransport {
  request(input: EzyVetTransportRequest): Promise<EzyVetTransportResponse>;
}

export interface EzyVetSite {
  readonly id: string;
  readonly timezone: string;
}

export interface EzyVetCatalogConnector {
  getSchedulingCatalog(): Promise<SchedulingCatalog>;
  getSite(): Promise<EzyVetSite>;
}
