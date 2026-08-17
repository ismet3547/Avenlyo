import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { MessageProcessingWorker } from './worker.js';

function workerFor(input: { readonly send: () => Promise<{ readonly messageSid: string }> }) {
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
    const send = vi.fn().mockResolvedValue({ messageSid: 'SM00000000000000000000000000000001' });
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
