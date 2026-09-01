import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { ApiSchedulingConnectorRegistry } from './connector-registry.js';
import {
  CustomerSchedulingCapabilityService,
  noCustomerSchedulingCapabilities,
} from './customer-scheduling-capabilities.js';

function serviceFor(input: {
  readonly catalogCount?: number;
  readonly canCancel?: boolean;
  readonly canReschedule?: boolean;
  readonly connectorFailure?: boolean;
  readonly context?: boolean;
}) {
  const rpc = vi.fn((name: string) => {
    if (name === 'get_conversation_scheduling_context') {
      return Promise.resolve({
        data:
          input.context === false
            ? []
            : [{ integration_id: 'integration-1', provider: 'google_calendar' }],
        error: null,
      });
    }
    if (name === 'get_scheduling_bookable_catalog') {
      return Promise.resolve({
        data: Array.from({ length: input.catalogCount ?? 1 }, () => ({ id: 'type-1' })),
        error: null,
      });
    }
    return Promise.resolve({ data: [], error: null });
  });
  const forIntegration = input.connectorFailure
    ? vi.fn().mockRejectedValue(new Error('unavailable'))
    : vi.fn().mockResolvedValue({
        appointmentLifecycle: {
          canCancel: input.canCancel ?? true,
          canReschedule: input.canReschedule ?? true,
        },
      });
  const service = new CustomerSchedulingCapabilityService({
    connectors: { forIntegration } as unknown as ApiSchedulingConnectorRegistry,
    supabase: { rpc } as unknown as SupabaseClient<Database>,
  });
  return { forIntegration, rpc, service };
}

describe('CustomerSchedulingCapabilityService', () => {
  it('exposes only capabilities proven by the current provider and bookable catalog', async () => {
    const { service } = serviceFor({ canCancel: true, canReschedule: false, catalogCount: 1 });

    await expect(service.forConversation('conversation-1')).resolves.toEqual({
      booking: true,
      cancel: true,
      lookup: true,
      reschedule: false,
    });
  });

  it('can retain lifecycle operations while booking has no current catalog', async () => {
    const { service } = serviceFor({ catalogCount: 0 });

    await expect(service.forConversation('conversation-1')).resolves.toEqual({
      booking: false,
      cancel: true,
      lookup: true,
      reschedule: true,
    });
  });

  it('fails closed when scheduling context or connector truth is unavailable', async () => {
    await expect(serviceFor({ context: false }).service.forConversation('conversation-1')).resolves.toEqual(
      noCustomerSchedulingCapabilities,
    );
    await expect(
      serviceFor({ connectorFailure: true }).service.forConversation('conversation-1'),
    ).resolves.toEqual(noCustomerSchedulingCapabilities);
  });
});
