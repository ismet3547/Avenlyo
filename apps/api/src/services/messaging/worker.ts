import { randomUUID } from 'node:crypto';

import { detectSmsKeywordCommand } from '@avenlyo/messaging';
import type { Database, MessageProcessingJobRow } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { TwilioOutboundClient } from './twilio.js';
import type { ConversationAgentService } from './conversation-agent.js';

const IDLE_POLL_MS = 1_000;

/** Small in-process worker backed by durable SQL claims; no timer spin occurs while work is running. */
export class MessageProcessingWorker {
  private active = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly workerId = `api-${randomUUID()}`;

  public constructor(
    private readonly input: {
      readonly agent?: ConversationAgentService;
      readonly concurrency?: number;
      readonly supabase: SupabaseClient<Database>;
      readonly twilio?: TwilioOutboundClient;
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
    const { data: jobs, error } = await this.input.supabase.rpc('claim_message_processing_jobs', {
      target_limit: this.input.concurrency ?? 4,
      target_worker_id: this.workerId,
    });
    if (error || !jobs.length) return;
    await Promise.all(jobs.map((job) => this.process(job)));
  }

  private async process(job: MessageProcessingJobRow): Promise<void> {
    try {
      if (job.job_kind === 'outbound_delivery') await this.deliverSms(job.message_id);
      else await this.replyToInbound(job.message_id);
      await this.input.supabase.rpc('complete_message_processing_job', {
        target_job_id: job.job_id,
      });
    } catch (error) {
      const code = error instanceof Error ? error.name : 'messaging_worker_failure';
      await this.input.supabase.rpc('retry_message_processing_job', {
        target_error_code: code,
        target_job_id: job.job_id,
      });
    }
  }

  private async replyToInbound(messageId: string): Promise<void> {
    const { data: runtimeRows, error: runtimeError } = await this.input.supabase.rpc(
      'get_message_runtime_context',
      { target_message_id: messageId },
    );
    const runtime = runtimeRows?.[0];
    if (runtimeError || !runtime || runtime.ai_mode !== 'ai') return;
    const { data: alreadyPersisted, error: persistedError } = await this.input.supabase.rpc(
      'has_persisted_ai_reply',
      { target_inbound_message_id: messageId },
    );
    if (persistedError || alreadyPersisted) return;
    const command = detectSmsKeywordCommand(runtime.body);
    if (runtime.channel_type === 'sms' && command === 'stop') return;
    if (runtime.channel_type === 'sms' && command === 'help') {
      await this.persist(
        messageId,
        'Reply STOP to opt out. A team member can help with your request.',
        false,
      );
      return;
    }
    if (runtime.channel_type === 'sms' && command === 'start') {
      await this.persist(
        messageId,
        'You are subscribed to messages from this business again.',
        false,
      );
      return;
    }
    if (!this.input.agent) throw new Error('Message agent is not configured.');
    const reply = await this.input.agent.replyTo(messageId);
    await this.persist(messageId, reply.text, reply.handoffRequested);
  }

  private async persist(messageId: string, body: string, handoffRequested: boolean): Promise<void> {
    const { error } = await this.input.supabase.rpc('persist_ai_message_reply', {
      target_body: body,
      target_handoff_requested: handoffRequested,
      target_inbound_message_id: messageId,
    });
    if (error) throw new Error('Assistant reply persistence failed.');
  }

  private async deliverSms(messageId: string): Promise<void> {
    if (!this.input.twilio) throw new Error('Twilio outbound delivery is not configured.');
    const { data, error } = await this.input.supabase.rpc('get_sms_delivery_execution_context', {
      target_message_id: messageId,
    });
    const execution = data?.[0];
    if (error || !execution) return;
    await this.input.supabase.rpc('mark_sms_delivery_sending', { target_message_id: messageId });
    try {
      const submission = await this.input.twilio.send({
        body: execution.body,
        from: execution.from_e164,
        to: execution.to_e164,
      });
      const { error: savedError } = await this.input.supabase.rpc(
        'record_sms_delivery_submission',
        {
          target_message_id: messageId,
          target_provider_message_id: submission.messageSid,
        },
      );
      if (savedError) throw new Error('SMS submission persistence failed.');
    } catch {
      // Once a provider request begins its outcome is ambiguous; retrying could duplicate an SMS.
      await this.input.supabase.rpc('mark_sms_delivery_unknown', {
        target_error_code: 'submission_unknown',
        target_message_id: messageId,
      });
    }
  }
}
