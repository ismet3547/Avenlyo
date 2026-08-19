import { randomUUID } from 'node:crypto';

import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { TwilioOutboundClient } from './twilio.js';

const IDLE_POLL_MS = 15_000;

interface LeadFollowupRpc {
  claim_lead_followup_delivery: {
    Args: { target_job_id: string };
    Returns: readonly {
      body: string;
      from_e164: string;
      message_id: string;
      to_e164: string;
    }[];
  };
  claim_lead_followup_jobs: {
    Args: { target_limit: number; target_worker_id: string };
    Returns: readonly { job_id: string; message_id: string | null }[];
  };
  create_lead_followup_message: {
    Args: { target_job_id: string };
    Returns: readonly { message_id: string }[];
  };
  mark_sms_delivery_unknown: {
    Args: { target_error_code: string; target_message_id: string };
    Returns: undefined;
  };
  record_sms_delivery_submission: {
    Args: {
      target_message_id: string;
      target_provider_message_id: string;
      target_provider_status: string;
    };
    Returns: undefined;
  };
}

type FollowupClient = SupabaseClient<Database> & {
  rpc: <Name extends keyof LeadFollowupRpc>(
    name: Name,
    args: LeadFollowupRpc[Name]['Args'],
  ) => Promise<{
    data: LeadFollowupRpc[Name]['Returns'] | null;
    error: { message: string } | null;
  }>;
};

/** Durable worker for the sole Phase 11 follow-up. It never retries an attempted provider submit. */
export class LeadFollowupWorker {
  private active = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly workerId = `lead-followup-${randomUUID()}`;

  public constructor(
    private readonly input: {
      readonly concurrency?: number;
      readonly supabase: SupabaseClient<Database>;
      readonly twilio: TwilioOutboundClient;
    },
  ) {}

  public start(): void {
    if (this.stopped || this.timer) return;
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.active || this.stopped) return;
    this.active = true;
    this.inFlight = this.run();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
      this.active = false;
      this.schedule(IDLE_POLL_MS);
    }
  }

  private async run(): Promise<void> {
    const supabase = this.input.supabase as FollowupClient;
    const { data: jobs, error } = await supabase.rpc('claim_lead_followup_jobs', {
      target_limit: this.input.concurrency ?? 4,
      target_worker_id: this.workerId,
    });
    if (error || !jobs?.length) return;
    await Promise.all(jobs.map((job) => this.process(supabase, job)));
  }

  private async process(
    supabase: FollowupClient,
    job: { readonly job_id: string; readonly message_id: string | null },
  ): Promise<void> {
    let messageId = job.message_id;
    if (!messageId) {
      const created = await supabase.rpc('create_lead_followup_message', {
        target_job_id: job.job_id,
      });
      if (created.error || !created.data?.[0]) return;
      messageId = created.data[0].message_id;
    }

    const claim = await supabase.rpc('claim_lead_followup_delivery', { target_job_id: job.job_id });
    const execution = claim.data?.[0];
    if (claim.error || !execution) return;
    try {
      const submission = await this.input.twilio.send({
        body: execution.body,
        from: execution.from_e164,
        to: execution.to_e164,
      });
      const saved = await supabase.rpc('record_sms_delivery_submission', {
        target_message_id: execution.message_id,
        target_provider_message_id: submission.messageSid,
        target_provider_status: submission.providerStatus,
      });
      if (saved.error) throw new Error('Lead follow-up submission persistence failed.');
    } catch {
      // The provider may have accepted the SMS. Phase 7's unknown terminal state prevents a resend.
      await supabase.rpc('mark_sms_delivery_unknown', {
        target_error_code: 'lead_followup_submission_unknown',
        target_message_id: messageId,
      });
    }
  }
}
