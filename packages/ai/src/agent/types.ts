import type { IndustryId, IndustryPack } from '@avenlyo/industries';

import type { CustomerIntent } from './intent-contract';
import type { KnowledgeSearchDiagnostic } from './knowledge-reliability';

export type AgentConversationRole = 'assistant' | 'customer';
export type AgentMode = 'customer' | 'test';
export type AgentConversationControlState = 'ai_active' | 'human_paused';

export interface AgentConversationWorkState {
  readonly control: AgentConversationControlState;
  /** Trusted application reference only; never accepted from model tool arguments. */
  readonly pendingMutation: {
    readonly actionIntentId: string;
    readonly intent: Extract<
      CustomerIntent,
      'APPOINTMENT_BOOK' | 'APPOINTMENT_CANCEL' | 'APPOINTMENT_RESCHEDULE'
    >;
  } | null;
}

/** Trusted routing identity supplied by an application adapter, never by a model tool call. */
export interface AgentExecutionContext {
  readonly conversationId: string;
  readonly industryId: IndustryId;
  readonly locationId: string | null;
  readonly mode: AgentMode;
  readonly organizationId: string;
  /** Trusted transport metadata supplied by the channel adapter, never model input. */
  readonly channel?: 'sms' | 'web' | undefined;
  /**
   * The current customer utterance, taken from trusted runtime input.
   *
   * Never model output and never a tool argument. The runtime fills it in from the turn it was
   * given, so a tool can tell whether the model searched the customer's actual question without
   * having to trust the model's account of it.
   */
  readonly customerMessage?: string | undefined;
  readonly triggeringInboundMessageId?: string | null | undefined;
}

export interface AgentBusinessContext {
  readonly address: string | null;
  readonly businessHours: string | null;
  readonly name: string;
  readonly phone: string | null;
  readonly timezone: string;
  readonly website: string | null;
  readonly locationName: string | null;
}

export interface AgentLiveContext {
  readonly localDateTime: string;
}

export interface AgentConversationMessage {
  readonly content: string;
  readonly role: AgentConversationRole;
}

export interface KnowledgeSource {
  readonly content: string;
  readonly similarity: number;
  readonly sourceUrl: string | null;
  readonly title: string;
}

export interface AgentToolCall {
  readonly arguments: string;
  readonly callId: string;
  readonly name: string;
}

export interface AgentToolExecution {
  readonly callId: string;
  readonly name: string;
  readonly status: 'failed' | 'rejected' | 'succeeded';
  readonly summary: string;
}

/** Opaque state retained only while a single provider tool loop is running. */
export interface AgentProviderContinuation {
  readonly encryptedReasoningItems: readonly {
    readonly encryptedContent: string;
    readonly id: string;
  }[];
  readonly provider: 'openai-responses';
}

export type AgentProviderInputItem =
  | {
      readonly content: string;
      readonly role: 'assistant' | 'user';
      readonly type: 'message';
    }
  | {
      /**
       * Knowledge the runtime retrieved itself, because the model tried to answer a
       * business-specific question without searching.
       *
       * A distinct item type rather than a forged `function_call` pair: the model did not call a
       * tool, and writing one into the transcript would make the provider's record of the turn a
       * lie. The provider renders this as a developer message, which is what it is.
       */
      readonly content: string;
      readonly type: 'runtime_knowledge';
    }
  | {
      readonly arguments: string;
      readonly callId: string;
      readonly name: string;
      readonly type: 'function_call';
    }
  | {
      readonly callId: string;
      readonly output: string;
      readonly type: 'function_call_output';
    }
  | {
      readonly continuation: AgentProviderContinuation;
      readonly type: 'provider_continuation';
    };

export interface AgentFunctionTool {
  readonly description: string;
  readonly name: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: true;
}

export interface AgentProviderInput {
  readonly input: readonly AgentProviderInputItem[];
  readonly instructions: string;
  readonly maxOutputTokens: number;
  readonly model: string;
  readonly tools: readonly AgentFunctionTool[];
}

export interface AgentProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface AgentProviderResult {
  /** Never persisted or exposed outside the provider/runtime boundary. */
  readonly continuation?: AgentProviderContinuation | undefined;
  readonly text: string;
  readonly toolCalls: readonly AgentToolCall[];
  readonly usage?: AgentProviderUsage | undefined;
}

/** Provider implementations may wrap transport details but never leak them to UI callers. */
export interface AgentProvider {
  readonly id: string;
  runTurn(input: AgentProviderInput): Promise<AgentProviderResult>;
}

export interface AgentTurnInput {
  readonly business: AgentBusinessContext;
  readonly context: AgentExecutionContext;
  readonly history: readonly AgentConversationMessage[];
  readonly industry: IndustryPack;
  readonly userMessage: string;
  /**
   * Application-owned conversation state. Customer-mode callers must supply it; test mode may omit
   * it and receives a deterministic AI-active/no-pending-mutation default.
   */
  readonly workState?: AgentConversationWorkState | undefined;
}

export interface AgentTurnResult {
  readonly failureCode?:
    'invalid_tool_call' | 'loop_limit' | 'provider_error' | 'tool_failure' | undefined;
  readonly handoffRequested: boolean;
  readonly model: string;
  readonly sources: readonly KnowledgeSource[];
  readonly text: string;
  readonly toolCalls: readonly AgentToolExecution[];
  readonly usage?: AgentProviderUsage | undefined;
  readonly suppressedReason?: 'human_control' | 'missing_work_state' | undefined;
  /**
   * Bounded, identity-free record of every knowledge search this turn performed.
   *
   * Returned rather than logged here, so the runtime stays free of I/O and every channel gets the
   * same evidence; whoever runs the turn decides whether to record it.
   */
  readonly knowledgeDiagnostics?: readonly KnowledgeSearchDiagnostic[] | undefined;
}

export class AgentProviderError extends Error {
  public constructor(
    public readonly code: 'configuration' | 'provider_error' | 'timeout',
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AgentProviderError';
  }
}
