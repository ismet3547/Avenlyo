import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { ConversationAgentService } from './conversation-agent.js';
import { MessageProcessingWorker } from './worker.js';

function runtimeContext() {
  return {
    ai_mode: 'ai',
    body: 'Yes, please do it.',
    channel_type: 'web',
    conversation_id: 'conversation-1',
    inbound_message_id: 'message-1',
    location_id: 'location-1',
    message_id: 'message-1',
    organization_id: 'organization-1',
  };
}

describe('Phase 23 durable handoff persistence boundary', () => {
  it('coalesces onto an existing durable handoff before persisting an AI handoff acknowledgement', async () => {
    const calls: string[] = [];
    const rpc = vi.fn((name: string) => {
      calls.push(name);
      if (name === 'get_message_runtime_context') {
        return Promise.resolve({ data: [runtimeContext()], error: null });
      }
      if (name === 'has_persisted_ai_reply') {
        return Promise.resolve({ data: false, error: null });
      }
      if (name === 'request_message_handoff') {
        return Promise.resolve({
          data: [{ created: false, handoff_id: 'handoff-existing' }],
          error: null,
        });
      }
      if (name === 'persist_ai_message_reply') {
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const replyTo = vi.fn().mockResolvedValue({
      handoffRequested: true,
      text: "I couldn't verify the appointment result, so I've asked the team to review it.",
    });
    const worker = new MessageProcessingWorker({
      agent: { replyTo } as unknown as ConversationAgentService,
      supabase: { rpc } as unknown as SupabaseClient<Database>,
    });

    await (worker as unknown as { replyToInbound(messageId: string): Promise<void> }).replyToInbound(
      'message-1',
    );

    expect(rpc).toHaveBeenCalledWith('request_message_handoff', {
      target_inbound_message_id: 'message-1',
      target_reason: 'Avenlyo requires human review before automated handling can continue.',
      target_tool_call_id: 'runtime-review:message-1',
      target_urgency: 'normal',
    });
    expect(rpc).toHaveBeenCalledWith('persist_ai_message_reply', {
      target_body: "I couldn't verify the appointment result, so I've asked the team to review it.",
      target_handoff_requested: true,
      target_inbound_message_id: 'message-1',
    });
    expect(calls.indexOf('request_message_handoff')).toBeLessThan(
      calls.indexOf('persist_ai_message_reply'),
    );
  });

  it('fails closed and does not persist a handoff acknowledgement when durable handoff creation fails', async () => {
    const rpc = vi.fn((name: string) => {
      if (name === 'get_message_runtime_context') {
        return Promise.resolve({ data: [runtimeContext()], error: null });
      }
      if (name === 'has_persisted_ai_reply') {
        return Promise.resolve({ data: false, error: null });
      }
      if (name === 'request_message_handoff') {
        return Promise.resolve({ data: null, error: { message: 'database unavailable' } });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const worker = new MessageProcessingWorker({
      agent: {
        replyTo: vi.fn().mockResolvedValue({
          handoffRequested: true,
          text: "I've asked the team to review it.",
        }),
      } as unknown as ConversationAgentService,
      supabase: { rpc } as unknown as SupabaseClient<Database>,
    });

    await expect(
      (worker as unknown as { replyToInbound(messageId: string): Promise<void> }).replyToInbound(
        'message-1',
      ),
    ).rejects.toThrow('Required human handoff could not be persisted.');
    expect(rpc).not.toHaveBeenCalledWith('persist_ai_message_reply', expect.anything());
  });
});
