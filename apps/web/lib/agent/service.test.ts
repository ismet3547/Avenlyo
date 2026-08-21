import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '@/lib/onboarding/types';
import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

const runTurn = vi.fn();
/** Captures the tool services the runtime is wired with, so the knowledge tool can be driven. */
let capturedToolServices: {
  searchBusinessKnowledge(
    input: { query: string; toolCallId: string },
    context: { conversationId: string; locationId: string | null },
  ): Promise<unknown>;
} | null = null;

vi.mock('@avenlyo/ai', () => ({
  AgentRuntime: class {
    public runTurn = runTurn;
  },
  ControlledToolExecutor: class {
    public constructor(_industry: unknown, services: never) {
      capturedToolServices = services;
    }
  },
  OpenAIResponsesProvider: class {},
}));

vi.mock('@/lib/knowledge/config', () => ({
  knowledgeServerEnv: { OPENAI_AGENT_MODEL: 'gpt-5.6', OPENAI_API_KEY: 'test-key' },
}));

vi.mock('@/lib/knowledge/service', () => ({ searchKnowledge: vi.fn(() => Promise.resolve([])) }));

const { AgentTestServiceError, runAgentTestTurn } = await import('./service');

const WORKSPACE = {
  businessHours: null,
  businessPhone: null,
  locationAddress: {},
  locationId: '10000000-0000-4000-8000-000000000001',
  locationName: 'Clinic',
  locationTimezone: 'UTC',
  organizationId: '20000000-0000-4000-8000-000000000001',
  organizationName: 'Avenlyo Vet',
  primaryIndustryId: 'veterinary',
  role: 'owner',
  websiteUrl: null,
} as unknown as TenantContext;

const AGENT_RESULT = {
  failureCode: null,
  handoffRequested: false,
  model: 'gpt-5.6',
  sources: [],
  text: 'We are open until six.',
  toolCalls: [],
};

type RpcResult = { data: unknown; error: { message: string } | null };

function clientWith(overrides: Readonly<Record<string, RpcResult>> = {}) {
  const defaults: Record<string, RpcResult> = {
    begin_agent_test_turn: {
      data: [{ is_existing: false, run_id: 'run-1', status: 'running' }],
      error: null,
    },
    // The success shape of a `returns void` function.
    complete_agent_test_turn: { data: null, error: null },
    fail_agent_test_turn: { data: null, error: null },
    get_agent_test_conversation: { data: [], error: null },
    record_agent_test_knowledge_search: { data: null, error: null },
  };
  const rpc = vi.fn((name: string) =>
    Promise.resolve(overrides[name] ?? defaults[name] ?? { data: null, error: null }),
  );
  return { client: { rpc } as unknown as AvenlyoSupabaseClient, rpc };
}

beforeEach(() => {
  runTurn.mockReset();
  capturedToolServices = null;
});

function run(client: AvenlyoSupabaseClient) {
  return runAgentTestTurn(
    client,
    WORKSPACE,
    '30000000-0000-4000-8000-000000000001',
    'What are your hours?',
    '40000000-0000-4000-8000-000000000001',
  );
}

/**
 * Three Agent Test runs were persisted `status=completed, failure_code=null` while the browser was
 * told the test could not be completed. `complete_agent_test_turn` is `returns void`, so its
 * success answer is `data: null, error: null`, and the strict guard treated that as failure — the
 * turn committed, the service threw, and the catch reported a provider error for work that had
 * already succeeded.
 */
describe('agent test turn completion', () => {
  it('accepts the void success answer and returns the persisted turn', async () => {
    runTurn.mockResolvedValue(AGENT_RESULT);
    const { client, rpc } = clientWith();

    await expect(run(client)).resolves.toEqual({
      failureCode: null,
      handoffRequested: false,
      model: 'gpt-5.6',
      sources: [],
      text: 'We are open until six.',
      tools: [],
    });
    expect(rpc).toHaveBeenCalledWith('complete_agent_test_turn', expect.anything());
    // The run completed, so nothing may mark it failed afterwards.
    expect(rpc).not.toHaveBeenCalledWith('fail_agent_test_turn', expect.anything());
  });

  it('still fails closed when the completion RPC reports an error', async () => {
    runTurn.mockResolvedValue(AGENT_RESULT);
    const { client, rpc } = clientWith({
      complete_agent_test_turn: { data: null, error: { message: 'deadlock detected' } },
    });

    await expect(run(client)).rejects.toBeInstanceOf(AgentTestServiceError);
    expect(rpc).toHaveBeenCalledWith('fail_agent_test_turn', {
      safe_failure_code: 'provider_error',
      target_run_id: 'run-1',
    });
  });

  it('does not surface the database message to the operator', async () => {
    runTurn.mockResolvedValue(AGENT_RESULT);
    const { client } = clientWith({
      complete_agent_test_turn: {
        data: null,
        error: { message: 'relation "runs" does not exist' },
      },
    });

    await expect(run(client)).rejects.toThrow(
      'The Agent Test could not be completed. Please try again.',
    );
  });

  it('accepts the void success answer from the knowledge-search record', async () => {
    runTurn.mockResolvedValue(AGENT_RESULT);
    const { client, rpc } = clientWith();
    await run(client);
    expect(capturedToolServices).not.toBeNull();

    await expect(
      capturedToolServices!.searchBusinessKnowledge(
        { query: 'hours', toolCallId: 'call-1' },
        {
          conversationId: '30000000-0000-4000-8000-000000000001',
          locationId: WORKSPACE.locationId,
        },
      ),
    ).resolves.toEqual([]);
    expect(rpc).toHaveBeenCalledWith('record_agent_test_knowledge_search', {
      target_conversation_id: '30000000-0000-4000-8000-000000000001',
      tool_call_id: 'call-1',
    });
  });

  it('still fails closed when the knowledge-search record reports an error', async () => {
    runTurn.mockResolvedValue(AGENT_RESULT);
    const { client } = clientWith({
      record_agent_test_knowledge_search: { data: null, error: { message: 'permission denied' } },
    });
    await run(client);

    await expect(
      capturedToolServices!.searchBusinessKnowledge(
        { query: 'hours', toolCallId: 'call-1' },
        {
          conversationId: '30000000-0000-4000-8000-000000000001',
          locationId: WORKSPACE.locationId,
        },
      ),
    ).rejects.toBeInstanceOf(AgentTestServiceError);
  });
});

describe('data-returning agent RPCs keep their strict null check', () => {
  it('rejects a begin-turn answer with no run row', async () => {
    const { client } = clientWith({ begin_agent_test_turn: { data: null, error: null } });
    await expect(run(client)).rejects.toBeInstanceOf(AgentTestServiceError);
  });

  it('rejects an empty begin-turn row set', async () => {
    const { client } = clientWith({ begin_agent_test_turn: { data: [], error: null } });
    await expect(run(client)).rejects.toBeInstanceOf(AgentTestServiceError);
  });

  it('rejects a transcript read that returns no data at all', async () => {
    runTurn.mockResolvedValue(AGENT_RESULT);
    const { client, rpc } = clientWith({
      get_agent_test_conversation: { data: null, error: null },
    });

    await expect(run(client)).rejects.toBeInstanceOf(AgentTestServiceError);
    expect(rpc).toHaveBeenCalledWith('fail_agent_test_turn', expect.anything());
  });
});

describe('idempotent recovery is unchanged', () => {
  it('returns the already-persisted turn for a repeated submission', async () => {
    const { client } = clientWith({
      begin_agent_test_turn: {
        data: [{ is_existing: true, run_id: 'run-1', status: 'completed' }],
        error: null,
      },
      get_agent_test_turn_result: {
        data: [
          {
            assistant_body: 'Recovered answer.',
            failure_code: null,
            handoff_requested: false,
            model: 'gpt-5.6',
            run_id: 'run-1',
            source_references: [],
            status: 'completed',
            tool_executions: [],
          },
        ],
        error: null,
      },
    });

    await expect(run(client)).resolves.toMatchObject({ text: 'Recovered answer.' });
    // Recovery reads the persisted result; it never re-runs the model.
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('asks for a new send key after a terminally failed earlier run', async () => {
    const { client } = clientWith({
      begin_agent_test_turn: {
        data: [{ is_existing: true, run_id: 'run-1', status: 'failed' }],
        error: null,
      },
      get_agent_test_turn_result: {
        data: [
          {
            assistant_body: null,
            failure_code: 'provider_error',
            handoff_requested: false,
            model: 'gpt-5.6',
            run_id: 'run-1',
            source_references: [],
            status: 'failed',
            tool_executions: [],
          },
        ],
        error: null,
      },
    });

    await expect(run(client)).rejects.toMatchObject({ submissionDisposition: 'replace-key' });
  });

  it('refuses a second message while a run is still processing', async () => {
    const { client } = clientWith({
      begin_agent_test_turn: {
        data: [{ is_existing: true, run_id: 'run-1', status: 'running' }],
        error: null,
      },
    });

    await expect(run(client)).rejects.toThrow(
      'This test conversation is already processing a message.',
    );
  });
});
