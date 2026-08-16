import { detectSafetyEscalation, type KnowledgeSource } from '@avenlyo/ai';
import {
  VoiceToolExecutor,
  sidebandEventSchema,
  type RealtimeCallControlProvider,
  type VoiceCallContext,
  type VoiceConfiguration,
  type VoiceRealtimeSocket,
  type VoiceSessionManager,
} from '@avenlyo/voice';

import type { VoiceStore } from './store.js';

export interface VoiceSidebandRuntimeOptions {
  readonly configuration: VoiceConfiguration;
  readonly context: VoiceCallContext;
  readonly control: RealtimeCallControlProvider;
  readonly embed: (query: string) => Promise<readonly number[]>;
  readonly sessions: VoiceSessionManager;
  readonly socket: VoiceRealtimeSocket;
  readonly store: VoiceStore;
}

/**
 * Handles only final transcript and function-call events. Audio data and partial deltas are never
 * retained or logged by this adapter.
 */
export class VoiceSidebandRuntime {
  private readonly executor: VoiceToolExecutor;
  private executionQueue: Promise<void> = Promise.resolve();
  private readonly auditedToolCallIds = new Set<string>();
  private readonly completedToolCallIds = new Set<string>();

  public constructor(private readonly options: VoiceSidebandRuntimeOptions) {
    const transferAllowed =
      options.configuration.transferEnabled &&
      options.configuration.providerTransferEnabled &&
      options.configuration.transferTargetE164 !== null;
    this.executor = new VoiceToolExecutor(
      options.context,
      {
        requestHumanHelp: async (input) => ({
          created: await options.store.requestHandoff({
            externalCallId: options.context.callId,
            reason: input.reason,
            toolCallId: input.toolCallId,
            urgency: input.urgency,
          }),
        }),
        searchBusinessKnowledge: async (input) => this.searchKnowledge(input.query),
        transferCall: async (input) => this.transfer(input.reason, input.toolCallId),
      },
      transferAllowed,
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
    this.options.sessions.recordActivity(this.options.context.callId);
    const safety = detectSafetyEscalation(this.options.context.industry, event.transcript);
    if (safety) {
      await this.options.store.requestHandoff({
        externalCallId: this.options.context.callId,
        reason: safety.reason,
        toolCallId: `safety:${event.item_id}`,
        urgency: safety.urgency,
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
    const result = await this.executor.execute({
      arguments: event.arguments,
      callId: event.call_id,
      name: event.name,
    });
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
