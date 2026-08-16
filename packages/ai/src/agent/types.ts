import type { IndustryId, IndustryPack } from '@avenlyo/industries';

export type AgentConversationRole = 'assistant' | 'customer';
export type AgentMode = 'customer' | 'test';

/** Trusted routing identity supplied by an application adapter, never by a model tool call. */
export interface AgentExecutionContext {
  readonly conversationId: string;
  readonly industryId: IndustryId;
  readonly locationId: string | null;
  readonly mode: AgentMode;
  readonly organizationId: string;
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
