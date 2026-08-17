import {
  SchedulingConnectorRegistry,
  type BookingConnector,
  type BookingProvider,
  type SchedulingConnectorFactory,
} from '@avenlyo/integrations';

import type { EzyVetIntegrationService } from './ezyvet-service.js';
import type { GoogleCalendarIntegrationService } from './google-calendar-service.js';

/** Keeps the only provider dispatch in the Fastify scheduling composition root. */
export class ApiSchedulingConnectorRegistry {
  private readonly registry: SchedulingConnectorRegistry;

  public constructor(input: {
    readonly ezyVet?: EzyVetIntegrationService;
    readonly googleCalendar?: GoogleCalendarIntegrationService;
  }) {
    const factories: SchedulingConnectorFactory[] = [];
    if (input.ezyVet) {
      factories.push({ provider: 'ezyvet', forIntegration: (integrationId) => input.ezyVet!.connectorForIntegration(integrationId) });
    }
    if (input.googleCalendar) {
      factories.push({ provider: 'google_calendar', forIntegration: (integrationId) => input.googleCalendar!.connectorForIntegration(integrationId) });
    }
    this.registry = new SchedulingConnectorRegistry(factories);
  }

  public forIntegration(provider: BookingProvider, integrationId: string): Promise<BookingConnector> {
    return this.registry.forIntegration(provider, integrationId);
  }
}
