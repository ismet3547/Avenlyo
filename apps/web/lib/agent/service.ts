import {
  AgentRuntime,
  ControlledToolExecutor,
  OpenAIResponsesProvider,
  type AgentConversationMessage,
  type AgentMode,
  type KnowledgeSearchDiagnostic,
} from '@avenlyo/ai';
import { getIndustryPack, resolveIndustryPack } from '@avenlyo/industries';
import type { Json } from '@avenlyo/database';

import { searchKnowledge } from '@/lib/knowledge/service';
import { knowledgeServerEnv } from '@/lib/knowledge/config';
import type { TenantContext } from '@/lib/onboarding/types';
import { createRpcGuards, type RpcError } from '@/lib/supabase/rpc';
import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

import type { AgentTestTurn } from './types';
import type { SubmissionDisposition } from './submission';

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
    name: 'fail_agent_test_turn',
    args: { safe_failure_code?: string; target_run_id: string },
  ): PromiseLike<{ data: null; error: RpcError | null }>;
  (
    name: 'get_agent_test_turn_result',
    args: { target_run_id: string },
  ): PromiseLike<{
    data:
      | {
          assistant_body: string | null;
          failure_code: AgentTestTurn['failureCode'];
          handoff_requested: boolean;
          model: string;
          run_id: string;
          source_references: Json;
          status: 'completed' | 'failed' | 'running';
          tool_executions: Json;
        }[]
      | null;
    error: RpcError | null;
  }>;
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

// `complete_agent_test_turn`, `fail_agent_test_turn`, and `record_agent_test_knowledge_search` are
// `returns void` in SQL, so PostgREST answers a success with null data. They go through
// requireVoidRpc; everything that is contractually required to return rows keeps the strict guard.
const { requireRpcData, requireVoidRpc } = createRpcGuards(() => new AgentTestServiceError());

export class AgentTestServiceError extends Error {
  public constructor(
    message = 'The Agent Test could not be completed. Please try again.',
    public readonly submissionDisposition: SubmissionDisposition = 'reuse-key',
  ) {
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

function persistedTurn(row: {
  assistant_body: string | null;
  failure_code: AgentTestTurn['failureCode'];
  handoff_requested: boolean;
  model: string;
  source_references: Json;
  tool_executions: Json;
}): AgentTestTurn | null {
  if (!row.assistant_body) return null;
  const sources = Array.isArray(row.source_references)
    ? row.source_references.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const title = item.title;
        const sourceUrl = item.source_url;
        return typeof title === 'string'
          ? [{ sourceUrl: typeof sourceUrl === 'string' ? sourceUrl : null, title }]
          : [];
      })
    : [];
  const tools: AgentTestTurn['tools'] = Array.isArray(row.tool_executions)
    ? row.tool_executions.flatMap<AgentTestTurn['tools'][number]>((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const name = item.name;
        const status = item.status;
        return typeof name === 'string' &&
          (status === 'succeeded' || status === 'failed' || status === 'rejected')
          ? [{ name, status }]
          : [];
      })
    : [];
  return {
    failureCode: row.failure_code,
    handoffRequested: row.handoff_requested,
    model: row.model,
    sources,
    text: row.assistant_body,
    tools,
  };
}

function requireIndustry(workspace: TenantContext) {
  if (!workspace.primaryIndustryId) {
    throw new AgentTestServiceError('Choose an industry before testing the AI Front Office.');
  }
  const pack = resolveIndustryPack(workspace.primaryIndustryId);
  if (!pack) throw new AgentTestServiceError('This workspace industry is not supported yet.');
  return getIndustryPack(pack.id);
}

/**
 * Writes the bounded knowledge-search diagnostic to the server log, and nowhere else.
 *
 * A log line rather than a table on purpose. The diagnostic exists to answer one operational
 * question during Phase 18 verification -- did the model search the customer's actual question, and
 * what numbers came back -- and a persisted diagnostic would need a read surface, and a read
 * surface needs authorization, and every one of those is a new way for test-mode data to escape.
 * There is nothing to authorize here because there is nothing to read back and nothing identifying
 * in it: no query, no customer words, no page text, no title, no URL, no tenant or location id.
 *
 * Test mode only. Customer-mode turns never reach this path.
 */
function recordAgentTestKnowledgeDiagnostics(
  diagnostics: readonly KnowledgeSearchDiagnostic[] | undefined,
): void {
  for (const diagnostic of diagnostics ?? []) {
    console.info(
      JSON.stringify({
        event: 'agent_test.knowledge_search',
        knowledgeOutcome: diagnostic.knowledgeOutcome,
        matches: diagnostic.matches,
        qualifiedCount: diagnostic.qualifiedCount,
        queryLength: diagnostic.queryLength,
        queryMatchesCustomerTurn: diagnostic.queryMatchesCustomerTurn,
        retrievedCount: diagnostic.retrievedCount,
        toolCallId: diagnostic.toolCallId,
        usedTrustedQueryRetry: diagnostic.usedTrustedQueryRetry,
      }),
    );
  }
}

export async function createAgentTestConversation(
  client: AvenlyoSupabaseClient,
  workspace: TenantContext,
): Promise<string> {
  if (!workspace.locationId) {
    throw new AgentTestServiceError('Choose a location before starting an Agent Test.');
  }
  const rows = await requireRpcData(
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
  const started = await requireRpcData(
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
    if (run.status === 'running') {
      throw new AgentTestServiceError('This test conversation is already processing a message.');
    }
    const persisted = (
      await requireRpcData(
        agentRpc(client)('get_agent_test_turn_result', { target_run_id: run.run_id }),
      )
    )[0];
    const turn = persisted ? persistedTurn(persisted) : null;
    if (turn) return turn;
    throw new AgentTestServiceError(
      'That earlier test message failed. Send it again as a new submission.',
      'replace-key',
    );
  }
  try {
    const transcript = await requireRpcData(
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
        const handoffs = await requireRpcData(
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
        await requireVoidRpc(
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

    recordAgentTestKnowledgeDiagnostics(result.knowledgeDiagnostics);

    await requireVoidRpc(
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
      sources: result.sources.map((source) => ({
        sourceUrl: source.sourceUrl,
        title: source.title,
      })),
      text: result.text,
      tools: result.toolCalls.map((tool) => ({ name: tool.name, status: tool.status })),
    };
  } catch {
    await agentRpc(client)('fail_agent_test_turn', {
      safe_failure_code: 'provider_error',
      target_run_id: run.run_id,
    });
    throw new AgentTestServiceError();
  }
}
