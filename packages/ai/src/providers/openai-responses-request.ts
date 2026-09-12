import type {
  FunctionTool,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseReasoningItem,
} from 'openai/resources/responses/responses';

import {
  AgentProviderError,
  type AgentProviderContinuation,
  type AgentProviderInput,
  type AgentProviderInputItem,
} from '../agent/types';

export function plainTextResponse(value: string): string {
  return value
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^(\s{0,3})#{1,6}[ \t]+/gm, '$1');
}

function toResponseInput(item: AgentProviderInputItem): readonly ResponseInputItem[] {
  if (item.type === 'message') {
    return [{ content: item.content, role: item.role, type: 'message' }];
  }
  if (item.type === 'runtime_knowledge') {
    // Retrieved website text is untrusted reference data, never developer authority.
    return [{ content: item.content, role: 'user', type: 'message' }];
  }
  if (item.type === 'function_call') {
    return [{ arguments: item.arguments, call_id: item.callId, name: item.name, type: 'function_call' }];
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

export function toEncryptedReasoningContinuation(
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
    ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
    parallel_tool_calls: false,
    store: false,
    tools: input.tools.map(toOpenAITool),
  };
}
