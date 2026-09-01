import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { ApiSchedulingConnectorRegistry } from './connector-registry.js';
import { VoiceBookingService } from './voice-booking-service.js';

function serviceWithRpc() {
  const rpc = vi.fn((name: string) => {
    if (name === 'get_voice_scheduling_context') {
      return Promise.resolve({
        data: [{ caller_e164: '+14155550123', conversation_id: 'conversation-1' }],
        error: null,
      });
    }
    if (name === 'claim_conversation_scheduling_booking_intent') {
      return Promise.resolve({
        data: [
          {
            booking_intent_id: 'booking-intent-1',
            confirmed_message_id: 'message-1',
            state: 'billing_unavailable',
          },
        ],
        error: null,
      });
    }
    if (name === 'get_voice_appointment_lifecycle_turn') {
      return Promise.resolve({
        data: [
          {
            conversation_id: 'conversation-1',
            inbound_message_id: 'message-1',
            trusted_caller_e164: '+14155550123',
          },
        ],
        error: null,
      });
    }
    if (name === 'claim_appointment_change_intent') {
      return Promise.resolve({
        data: [
          {
            change_intent_id: 'change-intent-1',
            confirmed_message_id: null,
            state: 'configuration_changed',
          },
        ],
        error: null,
      });
    }
    if (
      name === 'claim_presented_conversation_scheduling_booking_intent' ||
      name === 'claim_presented_appointment_change_intent'
    ) {
      throw new Error('Voice must never use the text presentation claim boundary.');
    }
    return Promise.resolve({ data: [], error: null });
  });

  return {
    rpc,
    service: new VoiceBookingService({
      connectors: { forIntegration: vi.fn() } as unknown as ApiSchedulingConnectorRegistry,
      supabase: { rpc } as unknown as SupabaseClient<Database>,
    }),
  };
}

describe('Phase 23 Voice confirmation claim mode', () => {
  it('uses the trusted Voice booking claim rather than the text presentation claim', async () => {
    const { rpc, service } = serviceWithRpc();

    await expect(
      service.bookAppointment(
        {
          bookingIntentId: 'booking-intent-1',
          confirmationText: 'Yes.',
          triggeringInboundMessageId: 'message-1',
          toolCallId: 'tool-1',
        },
        { callId: 'call-1' },
      ),
    ).resolves.toEqual({ outcome: 'unavailable' });

    expect(rpc).toHaveBeenCalledWith('claim_conversation_scheduling_booking_intent', {
      target_booking_intent_id: 'booking-intent-1',
      target_conversation_id: 'conversation-1',
      target_inbound_message_id: 'message-1',
      target_tool_call_id: 'tool-1',
    });
    expect(rpc).not.toHaveBeenCalledWith(
      'claim_presented_conversation_scheduling_booking_intent',
      expect.anything(),
    );
  });

  it('uses the trusted Voice lifecycle claim for reschedule/cancel execution', async () => {
    const { rpc, service } = serviceWithRpc();

    await expect(
      service.executeAppointmentChange(
        {
          changeIntentId: 'change-intent-1',
          triggeringInboundMessageId: 'message-1',
          toolCallId: 'tool-2',
        },
        { callId: 'call-1' },
      ),
    ).resolves.toEqual({ outcome: 'unavailable' });

    expect(rpc).toHaveBeenCalledWith('claim_appointment_change_intent', {
      target_change_intent_id: 'change-intent-1',
      target_conversation_id: 'conversation-1',
      target_inbound_message_id: 'message-1',
      target_tool_call_id: 'tool-2',
    });
    expect(rpc).not.toHaveBeenCalledWith(
      'claim_presented_appointment_change_intent',
      expect.anything(),
    );
  });
});
