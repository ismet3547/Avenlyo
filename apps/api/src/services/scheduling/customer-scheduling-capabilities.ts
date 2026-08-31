import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ApiSchedulingConnectorRegistry } from './connector-registry.js';

export interface CustomerSchedulingCapabilities {
  readonly booking: boolean;
  readonly cancel: boolean;
  readonly lookup: boolean;
  readonly reschedule: boolean;
}

export const noCustomerSchedulingCapabilities: CustomerSchedulingCapabilities = {
  booking: false,
  cancel: false,
  lookup: false,
  reschedule: false,
};

/**
 * Resolves customer-facing scheduling capability from current trusted runtime/provider state.
 *
 * This deliberately does not invent business controls that do not yet exist in the schema. The
 * resolver only narrows authority using facts Avenlyo can currently prove: an active scheduling
 * context, a reachable configured connector, a non-empty bookable catalog, and the connector's
 * source-controlled lifecycle capabilities. Any read/provider error fails closed to no tools while
 * unrelated knowledge, lead and handoff capabilities may continue.
 */
export class CustomerSchedulingCapabilityService {
  public constructor(
    private readonly input: {
      readonly connectors: ApiSchedulingConnectorRegistry;
      readonly supabase: SupabaseClient<Database>;
    },
  ) {}

  public async forConversation(conversationId: string): Promise<CustomerSchedulingCapabilities> {
    try {
      const { data: contextRows, error: contextError } = await this.input.supabase.rpc(
        'get_conversation_scheduling_context',
        {
          target_conversation_id: conversationId,
          target_inbound_message_id: null,
        },
      );
      const context = contextRows?.[0];
      if (contextError || !context) return noCustomerSchedulingCapabilities;

      const connector = await this.input.connectors.forIntegration(
        context.provider,
        context.integration_id,
      );
      const { data: catalog, error: catalogError } = await this.input.supabase.rpc(
        'get_scheduling_bookable_catalog',
        { target_integration_id: context.integration_id },
      );

      return {
        booking: !catalogError && (catalog?.length ?? 0) > 0,
        cancel: connector.appointmentLifecycle.canCancel,
        lookup: true,
        reschedule: connector.appointmentLifecycle.canReschedule,
      };
    } catch {
      return noCustomerSchedulingCapabilities;
    }
  }
}
