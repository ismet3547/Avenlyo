import OpenAI from 'openai';
import type {
  FunctionTool,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseReasoningItem,
} from 'openai/resources/responses/responses';

import { PROVIDER_TIMEOUT_MS } from '../agent/limits';
import {
  AgentProviderError,
  type AgentProvider,
  type AgentProviderContinuation,
  type AgentProviderInput,
  type AgentProviderInputItem,
  type AgentProviderResult,
} from '../agent/types';

export const defaultAgentModel = 'gpt-5.6';

export interface OpenAIResponsesProviderOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

function getProviderStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function toResponseInput(item: AgentProviderInputItem): readonly ResponseInputItem[] {
  if (item.type === 'message') {
    return [{ content: item.content, role: item.role, type: 'message' }];
  }
  if (item.type === 'function_call') {
    return [
      {
        arguments: item.arguments,
        call_id: item.callId,
        name: item.name,
        type: 'function_call',
      },
    ];
  }
  if (item.type === 'function_call_output') {
    return [{ call_id: item.callId, output: item.output, type: 'function_call_output' }];
  }
  if (item.continuation.provider !== 'openai-responses') {
    throw new AgentProviderError('configuration', 'Unsupported provider continuation.', false);
  }
  return item.continuation.encryptedReasoningItems.map((reasoning) => ({
    encrypted_content: reasoning.encryptedContent,
    id: reasoning.id,
    summary: [],
    type: 'reasoning' as const,
  }));
}

function toOpenAITool(tool: AgentProviderInput['tools'][number]): FunctionTool {
  return {
    description: tool.description,
    name: tool.name,
    parameters: tool.parameters,
    strict: tool.strict,
    type: 'function',
  };
}

function toEncryptedReasoningContinuation(
  item: ResponseReasoningItem,
): AgentProviderContinuation['encryptedReasoningItems'][number] | null {
  return item.encrypted_content ? { encryptedContent: item.encrypted_content, id: item.id } : null;
}

/** Kept pure so the retention and tool-safety contract is unit tested without network calls. */
export function buildResponsesRequest(input: AgentProviderInput): ResponseCreateParamsNonStreaming {
  return {
    input: input.input.flatMap(toResponseInput),
    include: ['reasoning.encrypted_content'],
    instructions: input.instructions,
    max_output_tokens: input.maxOutputTokens,
    model: input.model,
    parallel_tool_calls: false,
    // Avenlyo persists product conversation state; Responses API state must never be retained.
    store: false,
    tools: input.tools.map(toOpenAITool),
  };
}

/** Official OpenAI Responses API adapter. It is server-only and strips raw SDK objects at the boundary. */
export class OpenAIResponsesProvider implements AgentProvider {
  public readonly id = 'openai-responses';
  public readonly model: string;
  private readonly client: OpenAI;

  public constructor(options: OpenAIResponsesProviderOptions = {}) {
    if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
      throw new AgentProviderError(
        'configuration',
        'AI providers can only run on the server.',
        false,
      );
    }
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new AgentProviderError(
        'configuration',
        'OpenAI is not configured. Set OPENAI_API_KEY to test the AI Front Office.',
        false,
      );
    }
    this.model = options.model ?? process.env.OPENAI_AGENT_MODEL ?? defaultAgentModel;
    this.client = new OpenAI({
      apiKey,
      maxRetries: 1,
      timeout: options.timeoutMs ?? PROVIDER_TIMEOUT_MS,
    });
  }

  public async runTurn(input: AgentProviderInput): Promise<AgentProviderResult> {
    try {
      const response = await this.client.responses.create(buildResponsesRequest(input));
      const encryptedReasoningItems = response.output.flatMap((item) =>
        item.type === 'reasoning'
          ? [toEncryptedReasoningContinuation(item)].filter(
              (
                reasoning,
              ): reasoning is AgentProviderContinuation['encryptedReasoningItems'][number] =>
                reasoning !== null,
            )
          : [],
      );
      const continuation: AgentProviderContinuation | undefined = encryptedReasoningItems.length
        ? { encryptedReasoningItems, provider: 'openai-responses' }
        : undefined;
      return {
        continuation,
        text: response.output_text,
        toolCalls: response.output
          .filter((item) => item.type === 'function_call')
          .map((item) => ({
            arguments: item.arguments,
            callId: item.call_id,
            name: item.name,
          })),
        usage: response.usage
          ? {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
            }
          : undefined,
      };
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? getProviderStatus(error) : undefined;
      const retryable =
        status === 408 ||
        status === 409 ||
        status === 429 ||
        (status !== undefined && status >= 500);
      const code = error instanceof OpenAI.APIConnectionTimeoutError ? 'timeout' : 'provider_error';
      throw new AgentProviderError(code, 'The AI provider request failed.', retryable);
    }
  }
}
