import {
  AgentRuntime,
  ControlledToolExecutor,
  OpenAIResponsesProvider,
  type AgentConversationMessage,
  type AgentMode,
} from '@avenlyo/ai';
import { getIndustryPack, resolveIndustryPack } from '@avenlyo/industries';
import type { Json } from '@avenlyo/database';

import { searchKnowledge } from '@/lib/knowledge/service';
import { knowledgeServerEnv } from '@/lib/knowledge/config';
import type { TenantContext } from '@/lib/onboarding/types';
import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

import type { AgentTestTurn } from './types';

interface RpcError {
  message: string;
}

interface AgentRpcCaller {
  (
    name: 'create_agent_test_conversation',
    args: { target_location_id: string },
  ): PromiseLike<{ data: { conversation_id: string }[] | null; error: RpcError | null }>;
  (
    name: 'get_agent_test_conversation',
    args: { target_conversation_id: string },
  ): PromiseLike<{
    data:
      | {
          body: string | null;
          created_at: string;
          direction: 'inbound' | 'outbound' | 'internal';
          metadata: Json;
          message_id: string;
        }[]
      | null;
    error: RpcError | null;
  }>;
  (
    name: 'begin_agent_test_turn',
    args: {
      customer_message: string;
      model_name: string;
      provider_name: string;
      target_conversation_id: string;
      target_idempotency_key: string;
    },
  ): PromiseLike<{
    data:
      { is_existing: boolean; run_id: string; status: 'completed' | 'failed' | 'running' }[] | null;
    error: RpcError | null;
  }>;
  (
    name: 'complete_agent_test_turn',
    args: {
      assistant_body: string;
      handoff_requested: boolean;
      safe_failure_code: string | null;
      source_references: Json;
      target_run_id: string;
      tool_executions: Json;
    },
  ): PromiseLike<{ data: null; error: RpcError | null }>;
  (
    name: 'record_agent_test_knowledge_search',
    args: { target_conversation_id: string; tool_call_id: string },
  ): PromiseLike<{ data: null; error: RpcError | null }>;
  (
    name: 'request_agent_test_handoff',
    args: {
      handoff_reason: string;
      handoff_urgency: 'normal' | 'urgent';
      target_conversation_id: string;
      tool_call_id: string;
    },
  ): PromiseLike<{
    data: { created: boolean; handoff_id: string }[] | null;
    error: RpcError | null;
  }>;
}

function agentRpc(client: AvenlyoSupabaseClient): AgentRpcCaller {
  // Supabase's generated RPC overload is intentionally isolated behind this small typed boundary.
  return client.rpc.bind(client);
}

async function requireRpc<Result>(
  request: PromiseLike<{ data: Result | null; error: RpcError | null }>,
): Promise<Result> {
  const { data, error } = await request;
  if (error || data === null) throw new AgentTestServiceError();
  return data;
}

export class AgentTestServiceError extends Error {
  public constructor(message = 'The Agent Test could not be completed. Please try again.') {
    super(message);
    this.name = 'AgentTestServiceError';
  }
}

function businessHoursText(value: TenantContext['businessHours']): string | null {
  return value ? JSON.stringify(value) : null;
}

function conversationHistory(
  rows: readonly {
    body: string | null;
    direction: 'inbound' | 'outbound' | 'internal';
  }[],
): readonly AgentConversationMessage[] {
  return rows
    .filter((row) => row.direction !== 'internal' && Boolean(row.body))
    .map((row) => ({
      content: row.body ?? '',
      role: row.direction === 'inbound' ? 'customer' : 'assistant',
    }));
}

function sourceReferences(turn: Awaited<ReturnType<AgentRuntime['runTurn']>>): Json {
  return turn.sources.map((source) => ({
    source_url: source.sourceUrl,
    title: source.title,
  }));
}

function executionMetadata(turn: Awaited<ReturnType<AgentRuntime['runTurn']>>): Json {
  return turn.toolCalls.map((tool) => ({ name: tool.name, status: tool.status }));
}

function requireIndustry(workspace: TenantContext) {
  if (!workspace.primaryIndustryId) {
    throw new AgentTestServiceError('Choose an industry before testing the AI Front Office.');
  }
  const pack = resolveIndustryPack(workspace.primaryIndustryId);
  if (!pack) throw new AgentTestServiceError('This workspace industry is not supported yet.');
  return getIndustryPack(pack.id);
}

export async function createAgentTestConversation(
  client: AvenlyoSupabaseClient,
  workspace: TenantContext,
): Promise<string> {
  if (!workspace.locationId) {
    throw new AgentTestServiceError('Choose a location before starting an Agent Test.');
  }
  const rows = await requireRpc(
    agentRpc(client)('create_agent_test_conversation', {
      target_location_id: workspace.locationId,
    }),
  );
  const conversationId = rows[0]?.conversation_id;
  if (!conversationId) throw new AgentTestServiceError();
  return conversationId;
}

export async function runAgentTestTurn(
  client: AvenlyoSupabaseClient,
  workspace: TenantContext,
  conversationId: string,
  userMessage: string,
  idempotencyKey: string,
): Promise<AgentTestTurn> {
  const industry = requireIndustry(workspace);
  if (!knowledgeServerEnv.OPENAI_API_KEY) {
    throw new AgentTestServiceError('OpenAI is not configured for this environment.');
  }

  const model = knowledgeServerEnv.OPENAI_AGENT_MODEL;
  const started = await requireRpc(
    agentRpc(client)('begin_agent_test_turn', {
      customer_message: userMessage,
      model_name: model,
      provider_name: 'openai-responses',
      target_conversation_id: conversationId,
      target_idempotency_key: idempotencyKey,
    }),
  );
  const run = started[0];
  if (!run) throw new AgentTestServiceError();
  if (run.is_existing) {
    throw new AgentTestServiceError(
      'That test message was already submitted. Start a new message instead.',
    );
  }

  const transcript = await requireRpc(
    agentRpc(client)('get_agent_test_conversation', { target_conversation_id: conversationId }),
  );
  const history = conversationHistory(transcript).slice(0, -1);
  const context = {
    conversationId,
    industryId: industry.id,
    locationId: workspace.locationId,
    mode: 'test' as AgentMode,
    organizationId: workspace.organizationId,
  };
  const tools = new ControlledToolExecutor(industry, {
    requestHumanHelp: async (input, trustedContext) => {
      const handoffs = await requireRpc(
        agentRpc(client)('request_agent_test_handoff', {
          handoff_reason: input.reason,
          handoff_urgency: input.urgency,
          target_conversation_id: trustedContext.conversationId,
          tool_call_id: input.toolCallId,
        }),
      );
      return { created: handoffs[0]?.created === true };
    },
    searchBusinessKnowledge: async (input, trustedContext) => {
      const matches = await searchKnowledge(client, input.query, trustedContext.locationId);
      await requireRpc(
        agentRpc(client)('record_agent_test_knowledge_search', {
          target_conversation_id: trustedContext.conversationId,
          tool_call_id: input.toolCallId,
        }),
      );
      return matches.map((match) => ({
        content: match.content,
        similarity: match.similarity,
        sourceUrl: match.sourceUrl,
        title: match.title,
      }));
    },
  });
  const runtime = new AgentRuntime(
    new OpenAIResponsesProvider({
      apiKey: knowledgeServerEnv.OPENAI_API_KEY,
      model,
    }),
    tools,
    model,
  );
  const result = await runtime.runTurn({
    business: {
      address: workspace.locationAddress
        ? Object.values(workspace.locationAddress).filter(Boolean).join(', ')
        : null,
      businessHours: businessHoursText(workspace.businessHours),
      locationName: workspace.locationName,
      name: workspace.organizationName,
      phone: workspace.businessPhone,
      timezone: workspace.locationTimezone ?? 'UTC',
      website: workspace.websiteUrl,
    },
    context,
    history,
    industry,
    userMessage,
  });

  await requireRpc(
    agentRpc(client)('complete_agent_test_turn', {
      assistant_body: result.text,
      handoff_requested: result.handoffRequested,
      safe_failure_code: result.failureCode ?? null,
      source_references: sourceReferences(result),
      target_run_id: run.run_id,
      tool_executions: executionMetadata(result),
    }),
  );

  return {
    failureCode: result.failureCode ?? null,
    handoffRequested: result.handoffRequested,
    model: result.model,
    sources: result.sources.map((source) => ({ sourceUrl: source.sourceUrl, title: source.title })),
    text: result.text,
    tools: result.toolCalls.map((tool) => ({ name: tool.name, status: tool.status })),
  };
}
