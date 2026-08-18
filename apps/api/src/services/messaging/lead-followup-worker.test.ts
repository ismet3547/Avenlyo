import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { LeadFollowupWorker } from './lead-followup-worker.js';

function workerFor(input: {
  readonly send: () => Promise<{ readonly messageSid: string; readonly providerStatus: string }>;
}) {
  const rpc = vi.fn((name: string) => {
    if (name === 'claim_lead_followup_jobs') {
      return Promise.resolve({ data: [{ job_id: 'job-1', message_id: 'message-1' }], error: null });
    }
    if (name === 'claim_lead_followup_delivery') {
      return Promise.resolve({
        data: [
          {
            body: 'Hello',
            from_e164: '+14155550901',
            message_id: 'message-1',
            to_e164: '+14155550101',
          },
        ],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
  const worker = new LeadFollowupWorker({
    supabase: { rpc } as unknown as SupabaseClient<Database>,
    twilio: { send: input.send, verifySmsCapability: vi.fn() },
  });
  return { rpc, worker };
}

describe('LeadFollowupWorker', () => {
  it('uses the follow-up delivery claim before exactly one Twilio post', async () => {
    const send = vi.fn().mockResolvedValue({
      messageSid: 'SM00000000000000000000000000000001',
      providerStatus: 'queued',
    });
    const { rpc, worker } = workerFor({ send });

    await (worker as unknown as { run(): Promise<void> }).run();

    expect(rpc).toHaveBeenCalledWith('claim_lead_followup_delivery', { target_job_id: 'job-1' });
    expect(send).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('record_sms_delivery_submission', {
      target_message_id: 'message-1',
      target_provider_message_id: 'SM00000000000000000000000000000001',
      target_provider_status: 'queued',
    });
  });

  it('marks uncertain submission unknown without a blind resend', async () => {
    const send = vi.fn().mockRejectedValue(new Error('connection reset'));
    const { rpc, worker } = workerFor({ send });

    await (worker as unknown as { run(): Promise<void> }).run();

    expect(send).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('mark_sms_delivery_unknown', {
      target_error_code: 'lead_followup_submission_unknown',
      target_message_id: 'message-1',
    });
  });
});
