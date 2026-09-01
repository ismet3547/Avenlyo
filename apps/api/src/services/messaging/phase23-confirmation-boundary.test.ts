import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { ConversationAgentService } from './conversation-agent.js';
import { MessageProcessingWorker } from './worker.js';

function runtimeContext(channelType: 'sms' | 'web' = 'web') {
  return {
    ai_mode: 'ai',
    body: 'Friday at 2pm works.',
    channel_type: channelType,
    conversation_id: 'conversation-1',
    inbound_message_id: 'message-1',
    location_id: 'location-1',
    message_id: 'message-1',
    organization_id: 'organization-1',
  };
}

describe('Phase 23 confirmation persistence boundary', () => {
  it('uses the confirmation-specific atomic persistence RPC and never the generic reply path', async () => {
    const calls: string[] = [];
    const rpc = vi.fn((name: string) => {
      calls.push(name);
      if (name === 'get_message_runtime_context') {
        return Promise.resolve({ data: [runtimeContext()], error: null });
      }
      if (name === 'has_persisted_ai_reply') {
        return Promise.resolve({ data: false, error: null });
      }
      if (name === 'persist_ai_mutation_confirmation_reply') {
        return Promise.resolve({
          data: [{ bound: true, created: true, message_id: 'confirmation-message-1' }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const replyTo = vi.fn().mockResolvedValue({
      handoffRequested: false,
      mutationConfirmation: {
        actionIntentId: 'booking-intent-1',
        intent: 'APPOINTMENT_BOOK',
      },
      text: 'Please confirm: book Consultation for Bella. Reply YES to confirm.',
    });
    const worker = new MessageProcessingWorker({
      agent: { replyTo } as unknown as ConversationAgentService,
      supabase: { rpc } as unknown as SupabaseClient<Database>,
    });

    await (worker as unknown as { replyToInbound(messageId: string): Promise<void> }).replyToInbound(
      'message-1',
    );

    expect(rpc).toHaveBeenCalledWith('persist_ai_mutation_confirmation_reply', {
      target_action_intent_id: 'booking-intent-1',
      target_action_intent_type: 'APPOINTMENT_BOOK',
      target_body: 'Please confirm: book Consultation for Bella. Reply YES to confirm.',
      target_inbound_message_id: 'message-1',
    });
    expect(rpc).not.toHaveBeenCalledWith('persist_ai_message_reply', expect.anything());
  });

  it('fails closed instead of falling back to generic persistence when the action binding fails', async () => {
    const rpc = vi.fn((name: string) => {
      if (name === 'get_message_runtime_context') {
        return Promise.resolve({ data: [runtimeContext()], error: null });
      }
      if (name === 'has_persisted_ai_reply') {
        return Promise.resolve({ data: false, error: null });
      }
      if (name === 'persist_ai_mutation_confirmation_reply') {
        return Promise.resolve({
          data: [{ bound: false, created: true, message_id: 'orphan-message' }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const worker = new MessageProcessingWorker({
      agent: {
        replyTo: vi.fn().mockResolvedValue({
          handoffRequested: false,
          mutationConfirmation: {
            actionIntentId: 'change-intent-1',
            intent: 'APPOINTMENT_CANCEL',
          },
          text: 'Please confirm the cancellation. Reply YES to confirm.',
        }),
      } as unknown as ConversationAgentService,
      supabase: { rpc } as unknown as SupabaseClient<Database>,
    });

    await expect(
      (worker as unknown as { replyToInbound(messageId: string): Promise<void> }).replyToInbound(
        'message-1',
      ),
    ).rejects.toThrow('Mutation confirmation persistence failed.');
    expect(rpc).not.toHaveBeenCalledWith('persist_ai_message_reply', expect.anything());
  });
});
