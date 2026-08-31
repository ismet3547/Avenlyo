import { createHash } from 'node:crypto';

import {
  detectExplicitHumanRequest,
  detectSafetyEscalation,
  type KnowledgeSource,
} from '@avenlyo/ai';
import {
  VoiceToolExecutor,
  sidebandEventSchema,
  type RealtimeCallControlProvider,
  type VoiceCallContext,
  type VoiceConfiguration,
  type VoiceSchedulingServices,
  type VoiceRealtimeSocket,
  type VoiceSessionManager,
  type VoiceToolExecution,
} from '@avenlyo/voice';

import {
  noCustomerSchedulingCapabilities,
  type CustomerSchedulingCapabilities,
} from '../scheduling/customer-scheduling-capabilities.js';
import type { VoiceStore } from './store.js';
import { VoiceToolAuthorityState } from './tool-authority.js';

export interface VoiceSidebandRuntimeOptions {
  readonly configuration: VoiceConfiguration;
  readonly context: VoiceCallContext;
  readonly control: RealtimeCallControlProvider;
  readonly embed: (query: string) => Promise<readonly number[]>;
  readonly schedulingCapabilities?: CustomerSchedulingCapabilities;
  readonly sessions: VoiceSessionManager;
  readonly socket: VoiceRealtimeSocket;
  readonly scheduling?: VoiceSchedulingServices;
  readonly store: VoiceStore;
}

const mutationReviewTools = new Set(['book_appointment', 'reschedule_appointment', 'cancel_appointment']);

function unavailableCapability(): VoiceToolExecution {
  return {
    handoffRequested: false,
    modelOutput: JSON.stringify({ ok: false, message: 'The requested action is unavailable.' }),
    status: 'rejected',
    summary: 'Tool is unavailable for the current trusted capability state.',
    transferred: false,
  };
}

function mutationReviewCallId(callId: string): string {
  const digest = createHash('sha256').update(callId).digest('hex');
  return `mutation-review-${digest.slice(0, 48)}`;
}

function handoffUnavailableResult(): VoiceToolExecution {
  return {
    handoffRequested: false,
    modelOutput: JSON.stringify({
      ok: false,
      message:
        'The appointment action cannot continue safely, and the team could not be notified automatically. Do not retry this appointment action.',
    }),
    status: 'failed',
    summary: 'Appointment mutation requires human review, but handoff persistence failed.',
    transferred: false,
  };
}

/**
 * Handles only final transcript and function-call events. Audio data and partial deltas are never
 * retained or logged by this adapter.
 */
export class VoiceSidebandRuntime {
  private readonly executor: VoiceToolExecutor;
  private readonly authority: VoiceToolAuthorityState;
  private executionQueue: Promise<void> = Promise.resolve();
  private readonly auditedToolCallIds = new Set<string>();
  private readonly completedToolCallIds = new Set<string>();
  private latestCallerTranscript: string | null = null;
  private latestCallerTranscriptMessageId: string | null = null;
  private schedulingBlocked = false;

  public constructor(private readonly options: VoiceSidebandRuntimeOptions) {
    this.authority = new VoiceToolAuthorityState(
      options.schedulingCapabilities ?? noCustomerSchedulingCapabilities,
    );
    const transferAllowed =
      options.configuration.transferEnabled &&
      options.configuration.providerTransferEnabled &&
      options.configuration.transferTargetE164 !== null;
    this.executor = new VoiceToolExecutor(
      options.context,
      {
        ...(options.store.prepareFollowupConsent && options.store.confirmFollowupConsent
          ? {
              followupConsent: {
                prepare: (input, context) =>
                  options.store.prepareFollowupConsent!({
                    externalCallId: context.callId,
                    ...input,
                  }),
                confirm: (input, context) =>
                  options.store.confirmFollowupConsent!({
                    externalCallId: context.callId,
                    ...input,
                  }),
              },
            }
          : {}),
        ...(options.store.captureLead
          ? {
              leadCapture: {
                capture: (input, context) =>
                  options.store.captureLead!({
                    ...input,
                    externalCallId: context.callId,
                    industry: context.industry,
                  }),
              },
            }
          : {}),
        requestHumanHelp: async (input) => ({
          created: await options.store.requestHandoff({
            externalCallId: options.context.callId,
            reason: input.reason,
            toolCallId: input.toolCallId,
            urgency: input.urgency,
          }),
        }),
        searchBusinessKnowledge: async (input) => this.searchKnowledge(input.query),
        ...(options.scheduling ? { scheduling: options.scheduling } : {}),
        transferCall: async (input) => this.transfer(input.reason, input.toolCallId),
      },
      transferAllowed,
      options.scheduling !== undefined,
    );
  }

  public attach(): void {
    this.options.socket.onMessage((raw) => this.handleRawMessage(raw));
  }

  public startGreeting(greeting: string): void {
    this.options.socket.send({
      response: {
        instructions: `Start the call with this exact short greeting: ${greeting}`,
      },
      type: 'response.create',
    });
  }

  private handleRawMessage(raw: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    const parsed = sidebandEventSchema.safeParse(value);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      this.enqueue(() => this.handleCallerTranscript(event));
      return;
    }
    if (event.type === 'response.output_audio_transcript.done') {
      this.enqueue(() => this.handleAssistantTranscript(event));
      return;
    }
    if (event.type === 'response.function_call_arguments.done') {
      this.enqueue(() => this.handleToolCall(event));
      return;
    }
    this.options.sessions.recordIdleTimeout(this.options.context.callId);
  }

  private async handleCallerTranscript(event: {
    readonly item_id: string;
    readonly transcript: string;
  }): Promise<void> {
    const stored = await this.options.store.recordTranscript({
      body: event.transcript,
      direction: 'inbound',
      externalCallId: this.options.context.callId,
      externalItemId: event.item_id,
    });
    if (!stored) return;
    this.latestCallerTranscript = event.transcript;
    this.latestCallerTranscriptMessageId = stored;
    this.options.sessions.recordActivity(this.options.context.callId);

    // Interrupts are derived from the trusted final caller transcript, not from model tool intent.
    // Safety wins when the same utterance also asks for a person. Type and urgency are deliberately
    // separate: some safety policies are normal urgency and must still retain a safety audit key.
    const safety = detectSafetyEscalation(this.options.context.industry, event.transcript);
    const interrupt = safety ?? detectExplicitHumanRequest(event.transcript);
    if (interrupt) {
      this.schedulingBlocked = true;
      this.authority.clearSchedulingAuthority();
      await this.options.store.requestHandoff({
        externalCallId: this.options.context.callId,
        reason: interrupt.reason,
        toolCallId: `${safety ? 'safety' : 'human-request'}:${event.item_id}`,
        urgency: interrupt.urgency,
      });
    }
  }

  private async handleAssistantTranscript(event: {
    readonly item_id: string;
    readonly transcript: string;
  }): Promise<void> {
    const stored = await this.options.store.recordTranscript({
      body: event.transcript,
      direction: 'outbound',
      externalCallId: this.options.context.callId,
      externalItemId: event.item_id,
    });
    if (stored) this.options.sessions.recordActivity(this.options.context.callId);
  }

  private async handleToolCall(event: {
    readonly arguments: string;
    readonly call_id: string;
    readonly name: string;
  }): Promise<void> {
    // Realtime may replay a completed function call after a reconnect. The provider call ID is
    // the authoritative idempotency key for the entire sideband response sequence.
    if (this.completedToolCallIds.has(event.call_id)) return;
    const rawCall = {
      arguments: event.arguments,
      callId: event.call_id,
      confirmationText: this.latestCallerTranscript,
      triggeringInboundMessageId: this.latestCallerTranscriptMessageId,
      name: event.name,
      schedulingBlocked: this.schedulingBlocked,
    };
    let result: VoiceToolExecution;
    if (this.authority.allows(event.name)) {
      const trustedCall = this.authority.bind(rawCall);
      result = this.authority.observe(trustedCall, await this.executor.execute(trustedCall));
    } else {
      result = unavailableCapability();
    }

    // Provider uncertainty / handoff-required scheduling outcomes are not merely model hints.
    // Before another realtime response is allowed, persist/coalesce durable human work using the
    // trusted call identity, then permanently close scheduling authority for this live call. This
    // covers both provider_state_unknown and local completion failures after provider success.
    if (result.handoffRequested && mutationReviewTools.has(event.name)) {
      this.schedulingBlocked = true;
      this.authority.clearSchedulingAuthority();
      const persisted = await this.options.store.requestHandoff({
        externalCallId: this.options.context.callId,
        reason: 'An appointment action requires human review before automated handling can continue.',
        toolCallId: mutationReviewCallId(event.call_id),
        urgency: 'normal',
      });
      if (!persisted) result = handoffUnavailableResult();
    }

    if (!this.auditedToolCallIds.has(event.call_id)) {
      this.auditedToolCallIds.add(event.call_id);
      await this.options.store.recordToolExecution({
        externalCallId: this.options.context.callId,
        status: result.status,
        toolCallId: event.call_id,
        toolName: event.name,
      });
    }
    this.options.socket.send({
      item: {
        call_id: event.call_id,
        output: result.modelOutput,
        type: 'function_call_output',
      },
      type: 'conversation.item.create',
    });
    this.completedToolCallIds.add(event.call_id);
    if (result.transferred) return;
    this.options.socket.send({ type: 'response.create' });
  }

  private async searchKnowledge(query: string): Promise<readonly KnowledgeSource[]> {
    const embedding = await this.options.embed(query);
    return this.options.store.searchKnowledge({
      embedding,
      locationId: this.options.context.locationId,
      organizationId: this.options.context.organizationId,
    });
  }

  private async transfer(
    reason: string,
    toolCallId: string,
  ): Promise<{ readonly transferred: boolean }> {
    const target = this.options.configuration.transferTargetE164;
    if (
      !this.options.configuration.transferEnabled ||
      !this.options.configuration.providerTransferEnabled ||
      target === null
    ) {
      return { transferred: false };
    }
    const handoffPersisted = await this.options.store.requestHandoff({
      externalCallId: this.options.context.callId,
      reason,
      toolCallId,
      urgency: 'normal',
    });
    if (!handoffPersisted) return { transferred: false };
    try {
      await this.options.control.referCall(this.options.context.callId, target);
      await this.options.sessions.finalizeTransferred(this.options.context.callId);
      return { transferred: true };
    } catch {
      return { transferred: false };
    }
  }

  private enqueue(work: () => Promise<void>): void {
    // A failed persistence/provider operation must not permanently disable later final events.
    this.executionQueue = this.executionQueue.then(work).catch(() => undefined);
  }
}
