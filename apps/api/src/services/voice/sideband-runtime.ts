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
const terminalAcknowledgementMetadataKey = 'avenlyo_control';
const terminalAcknowledgementMetadataValue = 'handoff_ack';

const durableHandoffAcknowledgement =
  "I've notified the team. I'll stop here so a person can follow up.";
const failedHandoffAcknowledgement =
  "I can't continue safely right now, and I couldn't notify the team automatically. Please contact the business directly.";
const durableMutationReviewAcknowledgement =
  "I can't reliably verify that appointment action, so I won't repeat it. I've notified the team to check it.";
const failedMutationReviewAcknowledgement =
  "I can't reliably verify that appointment action, so I won't repeat it, and I couldn't notify the team automatically. Please contact the business directly.";

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

function urgentLeadHandoffUnavailableResult(): VoiceToolExecution {
  return {
    handoffRequested: false,
    modelOutput: JSON.stringify({
      ok: false,
      message: 'The urgent request needs human review, but the team could not be notified automatically.',
    }),
    status: 'failed',
    summary: 'Urgent lead requires human review, but handoff persistence failed.',
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
  private handoffTerminal = false;
  private terminalAcknowledgementResponseId: string | null = null;

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
    if (event.type === 'response.created') {
      this.enqueue(() => this.handleResponseCreated(event));
      return;
    }
    if (event.type === 'output_audio_buffer.stopped') {
      this.enqueue(() => this.handleOutputAudioBufferStopped(event));
      return;
    }
    if (!this.handoffTerminal) this.options.sessions.recordIdleTimeout(this.options.context.callId);
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
    if (this.handoffTerminal) return;

    // Interrupts are derived from the trusted final caller transcript, not from model tool intent.
    // Safety wins when the same utterance also asks for a person. Type and urgency are deliberately
    // separate: some safety policies are normal urgency and must still retain a safety audit key.
    const safety = detectSafetyEscalation(this.options.context.industry, event.transcript);
    const interrupt = safety ?? detectExplicitHumanRequest(event.transcript);
    if (interrupt) {
      this.schedulingBlocked = true;
      this.authority.clearSchedulingAuthority();
      const persisted = await this.persistHandoffSafely({
        reason: interrupt.reason,
        toolCallId: `${safety ? 'safety' : 'human-request'}:${event.item_id}`,
        urgency: interrupt.urgency,
      });
      this.enterTerminalHandoff(
        persisted ? durableHandoffAcknowledgement : failedHandoffAcknowledgement,
        true,
      );
    }
  }

  private async handleAssistantTranscript(event: {
    readonly item_id: string;
    readonly response_id?: string | undefined;
    readonly transcript: string;
  }): Promise<void> {
    // After terminal handoff begins, canceled/racing model audio is not durable customer history.
    // Only the one server-marked acknowledgement whose response ID we observed is persisted.
    if (
      this.handoffTerminal &&
      (this.terminalAcknowledgementResponseId === null ||
        event.response_id !== this.terminalAcknowledgementResponseId)
    ) {
      return;
    }
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
    // Once durable human attention owns this call, late function events from a canceled response
    // have no authority and receive no new model turn; the bounded acknowledgement is already queued.
    if (this.handoffTerminal) return;
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

    let terminalAcknowledgement: string | null = null;

    // Provider uncertainty / handoff-required scheduling outcomes are not merely model hints.
    // Before another realtime response is allowed, persist/coalesce durable human work using the
    // trusted call identity, then permanently close scheduling authority for this live call. This
    // covers both provider_state_unknown and local completion failures after provider success.
    if (result.handoffRequested && mutationReviewTools.has(event.name)) {
      this.schedulingBlocked = true;
      this.authority.clearSchedulingAuthority();
      const persisted = await this.persistHandoffSafely({
        reason: 'An appointment action requires human review before automated handling can continue.',
        toolCallId: mutationReviewCallId(event.call_id),
        urgency: 'normal',
      });
      terminalAcknowledgement = persisted
        ? durableMutationReviewAcknowledgement
        : failedMutationReviewAcknowledgement;
      if (!persisted) result = handoffUnavailableResult();
    } else if (event.name === 'request_human_help' && !result.transferred) {
      // The executor only reports handoffRequested=true when the durable request succeeded.
      // A failed request still ends normal AI ownership, but must not claim that staff was notified.
      terminalAcknowledgement = result.handoffRequested
        ? durableHandoffAcknowledgement
        : failedHandoffAcknowledgement;
    } else if (event.name === 'capture_lead' && result.handoffRequested && !result.transferred) {
      // Urgent-lead policy already asked for this exact idempotent handoff inside the executor.
      // Re-read/replay the same durable boundary here so terminal customer language never relies
      // on a model-visible boolean alone.
      const persisted = await this.persistHandoffSafely({
        reason: 'An urgent lead needs a team follow-up.',
        toolCallId: `${event.call_id}:urgent-lead`,
        urgency: 'urgent',
      });
      terminalAcknowledgement = persisted
        ? durableHandoffAcknowledgement
        : failedHandoffAcknowledgement;
      if (!persisted) result = urgentLeadHandoffUnavailableResult();
    } else if (event.name === 'transfer_call' && result.status === 'failed' && !result.transferred) {
      // The transfer adapter creates durable human work before SIP REFER. If REFER then fails, the
      // Inbox work survives and the call becomes a truthful post-call handoff, never a fake transfer.
      const persisted = await this.persistHandoffSafely({
        reason: 'A live call transfer could not be completed; a team follow-up is required.',
        toolCallId: event.call_id,
        urgency: 'normal',
      });
      terminalAcknowledgement = persisted
        ? durableHandoffAcknowledgement
        : failedHandoffAcknowledgement;
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
    if (terminalAcknowledgement) {
      this.enterTerminalHandoff(terminalAcknowledgement, false);
      return;
    }
    this.options.socket.send({ type: 'response.create' });
  }

  private handleResponseCreated(event: {
    readonly response: {
      readonly id: string;
      readonly metadata?: Record<string, unknown> | null | undefined;
    };
  }): Promise<void> {
    if (
      this.handoffTerminal &&
      event.response.metadata?.[terminalAcknowledgementMetadataKey] ===
        terminalAcknowledgementMetadataValue
    ) {
      this.terminalAcknowledgementResponseId = event.response.id;
    }
    return Promise.resolve();
  }

  private async handleOutputAudioBufferStopped(event: {
    readonly response_id: string;
  }): Promise<void> {
    if (
      !this.handoffTerminal ||
      this.terminalAcknowledgementResponseId === null ||
      event.response_id !== this.terminalAcknowledgementResponseId
    ) {
      return;
    }
    await this.options.sessions.finalizeHandoff(this.options.context.callId);
  }

  private enterTerminalHandoff(acknowledgement: string, cancelExistingResponse: boolean): void {
    if (this.handoffTerminal) return;
    this.handoffTerminal = true;
    this.schedulingBlocked = true;
    this.authority.clearSchedulingAuthority();

    // Stop server-VAD from producing any more autonomous turns. Only the manually-created bounded
    // acknowledgement below remains authorized. This is server-side control, not a prompt request.
    this.options.socket.send({
      session: {
        audio: { input: { turn_detection: null } },
        tools: [],
        type: 'realtime',
      },
      type: 'session.update',
    });

    if (cancelExistingResponse) {
      // A final caller transcript may race a server-VAD response. Cancel generated continuation
      // and clear already-buffered SIP audio before issuing the one approved acknowledgement.
      this.options.socket.send({ type: 'response.cancel' });
      this.options.socket.send({ type: 'output_audio_buffer.clear' });
    }

    this.options.socket.send({
      response: {
        instructions: `Say exactly this sentence and nothing else: ${JSON.stringify(acknowledgement)}`,
        metadata: {
          [terminalAcknowledgementMetadataKey]: terminalAcknowledgementMetadataValue,
        },
        tools: [],
      },
      type: 'response.create',
    });
  }

  private async persistHandoffSafely(input: {
    readonly reason: string;
    readonly toolCallId: string;
    readonly urgency: 'normal' | 'urgent';
  }): Promise<boolean> {
    try {
      return await this.options.store.requestHandoff({
        externalCallId: this.options.context.callId,
        ...input,
      });
    } catch {
      return false;
    }
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
    const handoffPersisted = await this.persistHandoffSafely({
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
