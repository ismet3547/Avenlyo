import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import type { ConversationAgentService } from './conversation-agent.js';
import { MessageProcessingWorker } from './worker.js';

function workerFor(input: {
  readonly send: () => Promise<{ readonly messageSid: string; readonly providerStatus: string }>;
}) {
  const rpc = vi.fn((name: string) => {
    if (name === 'claim_sms_delivery_submission') {
      return Promise.resolve({
        data: [
          {
            body: 'Hello',
            delivery_id: 'delivery-1',
            from_e164: '+14155550901',
            message_id: 'message-1',
            status: 'submitting',
            to_e164: '+14155550101',
          },
        ],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
  const worker = new MessageProcessingWorker({
    supabase: { rpc } as unknown as SupabaseClient<Database>,
    twilio: { send: input.send, verifySmsCapability: vi.fn() },
  });
  return { rpc, worker };
}

describe('MessageProcessingWorker SMS submission', () => {
  it('uses the atomic submission claim before exactly one Twilio post', async () => {
    const send = vi.fn().mockResolvedValue({
      messageSid: 'SM00000000000000000000000000000001',
      providerStatus: 'queued',
    });
    const { rpc, worker } = workerFor({ send });

    await (worker as unknown as { deliverSms(messageId: string): Promise<void> }).deliverSms(
      'message-1',
    );

    expect(rpc).toHaveBeenCalledWith('claim_sms_delivery_submission', {
      target_message_id: 'message-1',
    });
    expect(send).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('record_sms_delivery_submission', {
      target_message_id: 'message-1',
      target_provider_message_id: 'SM00000000000000000000000000000001',
      target_provider_status: 'queued',
    });
  });

  it('marks a started submission unknown after a provider error and never retries it itself', async () => {
    const send = vi.fn().mockRejectedValue(new Error('connection reset'));
    const { rpc, worker } = workerFor({ send });

    await (worker as unknown as { deliverSms(messageId: string): Promise<void> }).deliverSms(
      'message-1',
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('mark_sms_delivery_unknown', {
      target_error_code: 'submission_unknown',
      target_message_id: 'message-1',
    });
  });
});

describe('MessageProcessingWorker AI ownership boundary', () => {
  it('does not persist a transcript message when the trusted agent work state suppresses the turn', async () => {
    const rpc = vi.fn((name: string) => {
      if (name === 'get_message_runtime_context') {
        return Promise.resolve({
          data: [
            {
              ai_mode: 'ai',
              body: 'Hello',
              channel_type: 'web',
              conversation_id: 'conversation-1',
              inbound_message_id: 'message-1',
              location_id: 'location-1',
              message_id: 'message-1',
              organization_id: 'organization-1',
            },
          ],
          error: null,
        });
      }
      if (name === 'has_persisted_ai_reply') {
        return Promise.resolve({ data: false, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    const replyTo = vi.fn().mockResolvedValue({
      handoffRequested: false,
      suppressed: true,
      text: '',
    });
    const worker = new MessageProcessingWorker({
      agent: { replyTo } as unknown as ConversationAgentService,
      supabase: { rpc } as unknown as SupabaseClient<Database>,
    });

    await (worker as unknown as { replyToInbound(messageId: string): Promise<void> }).replyToInbound(
      'message-1',
    );

    expect(replyTo).toHaveBeenCalledWith('message-1');
    expect(rpc).not.toHaveBeenCalledWith('persist_ai_message_reply', expect.anything());
  });
});
