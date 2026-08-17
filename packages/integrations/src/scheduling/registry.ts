import type { BookingConnector, BookingProvider } from './types';

export interface SchedulingConnectorFactory {
  readonly provider: BookingProvider;
  forIntegration(integrationId: string): Promise<BookingConnector>;
}

/** One auditable boundary for mapping trusted integration configuration to an adapter. */
export class SchedulingConnectorRegistry {
  private readonly factories: ReadonlyMap<BookingProvider, SchedulingConnectorFactory>;

  public constructor(factories: readonly SchedulingConnectorFactory[]) {
    this.factories = new Map(factories.map((factory) => [factory.provider, factory]));
  }

  public async forIntegration(provider: BookingProvider, integrationId: string): Promise<BookingConnector> {
    const factory = this.factories.get(provider);
    if (!factory) throw new Error(`No scheduling connector is registered for ${provider}.`);
    return factory.forIntegration(integrationId);
  }
}
