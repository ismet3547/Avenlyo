import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { ApiSchedulingConnectorRegistry } from './connector-registry.js';
import { SchedulingBookingService } from './scheduling-booking-service.js';

describe('SchedulingBookingService transport identity', () => {
  it('fails closed for web chat ezyVet preparation without a trusted transport sender', async () => {
    const forIntegration = vi.fn();
    const rpc = vi.fn((name: string) => {
      if (name === 'get_conversation_scheduling_context') {
        return Promise.resolve({
          data: [
            {
              channel_type: 'web',
              conversation_id: 'conversation-1',
              provider: 'ezyvet',
              trusted_transport_phone_e164: null,
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    });
    const service = new SchedulingBookingService({
      connectors: { forIntegration } as unknown as ApiSchedulingConnectorRegistry,
      supabase: { rpc } as unknown as SupabaseClient<Database>,
    });

    await expect(
      service.prepareAppointmentBooking(
        { candidateId: 'candidate-1', subjectName: 'Max', toolCallId: 'tool-1' },
        { conversationId: 'conversation-1', triggeringInboundMessageId: 'web-message-1' },
      ),
    ).resolves.toEqual({ intent: null, outcome: 'not_found' });

    expect(forIntegration).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith(
      'prepare_conversation_scheduling_booking_intent',
      expect.anything(),
    );
  });

  it('routes customer booking execution through the presented-confirmation claim boundary', async () => {
    const rpc = vi.fn((name: string) => {
      if (name === 'claim_presented_conversation_scheduling_booking_intent') {
        return Promise.resolve({
          data: [
            {
              booking_intent_id: 'booking-intent-1',
              confirmed_message_id: null,
              state: 'confirmation_required',
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: [], error: null });
    });
    const service = new SchedulingBookingService({
      connectors: { forIntegration: vi.fn() } as unknown as ApiSchedulingConnectorRegistry,
      supabase: { rpc } as unknown as SupabaseClient<Database>,
    });

    await expect(
      service.bookAppointment(
        { bookingIntentId: 'booking-intent-1', toolCallId: 'tool-1' },
        { conversationId: 'conversation-1', triggeringInboundMessageId: 'message-1' },
      ),
    ).resolves.toEqual({ outcome: 'confirmation_required' });

    expect(rpc).toHaveBeenCalledWith('claim_presented_conversation_scheduling_booking_intent', {
      target_booking_intent_id: 'booking-intent-1',
      target_conversation_id: 'conversation-1',
      target_inbound_message_id: 'message-1',
      target_tool_call_id: 'tool-1',
    });
    expect(rpc).not.toHaveBeenCalledWith(
      'claim_conversation_scheduling_booking_intent',
      expect.anything(),
    );
  });
});
