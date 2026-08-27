import { veterinaryPack } from '@avenlyo/industries';
import { describe, expect, it, vi } from 'vitest';

import { ControlledToolExecutor } from '../tools/executor';
import type { AgentToolServices } from '../tools/types';

import { MAX_TRUSTED_QUERY_RECOVERIES_PER_TURN } from './knowledge-reliability';
import type { AgentExecutionContext, KnowledgeSource } from './types';

/**
 * The trusted-query recovery, and the boundaries it must not cross.
 *
 * Measured on staging: the model rewrites the customer's question before searching and the rewrite
 * retrieves worse. The customer's registration question scored 0.611 searched verbatim; the model's
 * 99-character reformulation of it returned 0.533/0.487 and qualified nothing, so the customer was
 * refused an answer that had been published minutes earlier.
 *
 * Recovery widens *which query is tried*, never what counts as reliable. Every case below asserts
 * one of those two halves.
 */

const CUSTOMER_TURN = 'Nasil kayit olucam?';

function match(similarity: number, title = 'Page'): KnowledgeSource {
  return {
    content: `Published body for ${title}.`,
    similarity,
    sourceUrl: `https://clinic.test/${title.toLowerCase()}`,
    title,
  };
}

/** The staging shape: the model's rewrite is flat, the customer's own words are strong. */
const MODEL_QUERY_FLAT = [match(0.533, 'Flat1'), match(0.487, 'Flat2'), match(0.363, 'Flat3')];
const CUSTOMER_QUERY_STRONG = [match(0.611, 'HesapOlustur'), match(0.53, 'GirisYap')];

function context(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    conversationId: '00000000-0000-4000-8000-000000000001',
    customerMessage: CUSTOMER_TURN,
    industryId: 'veterinary',
    locationId: '00000000-0000-4000-8000-000000000002',
    mode: 'test',
    organizationId: '00000000-0000-4000-8000-000000000003',
    ...overrides,
  };
}

/** Answers each distinct query with its own result set, and records what was asked. */
function executorFor(byQuery: Record<string, readonly KnowledgeSource[]>, fallback = MODEL_QUERY_FLAT) {
  const queries: string[] = [];
  const searchBusinessKnowledge = vi.fn((input: { query: string }) => {
    queries.push(input.query);
    return Promise.resolve(byQuery[input.query] ?? fallback);
  });
  const services = {
    requestHumanHelp: vi.fn().mockResolvedValue({ created: true }),
    searchBusinessKnowledge,
  } as unknown as AgentToolServices;
  return { executor: new ControlledToolExecutor(veterinaryPack, services), queries };
}

function call(query: string, callId = 'fc_1') {
  return { arguments: JSON.stringify({ query }), callId, name: 'search_business_knowledge' };
}

describe('the model query is always tried first', () => {
  it('does not search again when the model query already found something reliable', async () => {
    const { executor, queries } = executorFor({
      'account registration page': [match(0.7, 'Strong')],
    });

    const result = await executor.execute(call('account registration page'), context());

    expect(queries).toEqual(['account registration page']);
    expect(result.knowledgeDiagnostic?.origin).toBe('model_search');
    expect(result.sources.map((source) => source.title)).toEqual(['Strong']);
  });

  it('never searches twice when the model already asked the customer question', async () => {
    // The optimisation that matters: a model that quotes the customer verbatim must not pay for
    // the identical embedding and vector query a second time.
    const { executor, queries } = executorFor({ [CUSTOMER_TURN]: MODEL_QUERY_FLAT });

    const result = await executor.execute(call(CUSTOMER_TURN), context());

    expect(queries).toEqual([CUSTOMER_TURN]);
    expect(result.knowledgeDiagnostic?.origin).toBe('model_search');
    expect(result.knowledgeOutcome).toBe('empty_or_unreliable');
  });

  it('treats a differently-cased or padded restatement as the same query', async () => {
    const { executor, queries } = executorFor({});

    await executor.execute(call('  NASIL   Kayit Olucam?  '), context());

    expect(queries).toHaveLength(1);
  });
});

describe('recovery runs once when the model query found nothing usable', () => {
  it('answers from the customer question when the model rewrite was flat', async () => {
    const { executor, queries } = executorFor({
      'how does a new user create an account on your website platform': MODEL_QUERY_FLAT,
      [CUSTOMER_TURN]: CUSTOMER_QUERY_STRONG,
    });

    const result = await executor.execute(
      call('how does a new user create an account on your website platform'),
      context(),
    );

    expect(queries).toEqual([
      'how does a new user create an account on your website platform',
      CUSTOMER_TURN,
    ]);
    expect(result.knowledgeOutcome).toBe('reliable');
    expect(result.sources.map((source) => source.title)).toEqual(['HesapOlustur']);
    expect(result.knowledgeDiagnostic).toMatchObject({
      qualifiedCount: 1,
      queryMatchesCustomerTurn: false,
      origin: 'trusted_query_retry',
    });
  });

  it('passes only the qualifying source from the recovery, not the whole set', async () => {
    // 0.53 is above the floor and below strong, and it is not the top. It made the winner's lead
    // meaningful; it did not become an answer.
    const { executor } = executorFor({ [CUSTOMER_TURN]: CUSTOMER_QUERY_STRONG });

    const result = await executor.execute(call('an unrelated rewrite entirely'), context());

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.title).toBe('HesapOlustur');
  });

  it('accepts a comparative winner from the recovery on the same terms as any other search', async () => {
    const { executor } = executorFor({
      [CUSTOMER_TURN]: [match(0.573, 'Winner'), match(0.422, 'RunnerUp'), match(0.296, 'Noise')],
    });

    const result = await executor.execute(call('some rewritten question'), context());

    expect(result.knowledgeOutcome).toBe('reliable');
    expect(result.sources.map((source) => source.title)).toEqual(['Winner']);
    expect(result.knowledgeDiagnostic?.matches[0]?.decision).toBe('comparative_winner');
  });
});

describe('recovery cannot rescue an answer the corpus does not support', () => {
  it('still refuses when the customer question is flat too', async () => {
    const { executor, queries } = executorFor({
      [CUSTOMER_TURN]: [match(0.46), match(0.44), match(0.41)],
    });

    const result = await executor.execute(call('a rewritten question'), context());

    // It tried, and the honest answer did not change. This is the property that keeps the fix from
    // being a quiet loosening of the reliability rule.
    expect(queries).toHaveLength(2);
    expect(result.knowledgeOutcome).toBe('empty_or_unreliable');
    expect(result.sources).toEqual([]);
    expect(result.knowledgeDiagnostic?.origin).toBe('trusted_query_retry');
  });

  it('still refuses when the customer question is below the floor', async () => {
    const { executor } = executorFor({ [CUSTOMER_TURN]: [match(0.3), match(0.02)] });

    const result = await executor.execute(call('a rewritten question'), context());

    expect(result.knowledgeOutcome).toBe('empty_or_unreliable');
  });

  it('still refuses a lone moderate match found by the recovery', async () => {
    const { executor } = executorFor({ [CUSTOMER_TURN]: [match(0.44)] });

    const result = await executor.execute(call('a rewritten question'), context());

    expect(result.knowledgeOutcome).toBe('empty_or_unreliable');
  });
});

describe('recovery is bounded', () => {
  it('runs at most once per agent turn however many times the tool is called', async () => {
    const { executor, queries } = executorFor({ [CUSTOMER_TURN]: MODEL_QUERY_FLAT });

    await executor.execute(call('first rewrite', 'fc_1'), context());
    await executor.execute(call('second rewrite', 'fc_2'), context());
    await executor.execute(call('third rewrite', 'fc_3'), context());

    // Three model searches, and exactly one recovery across the whole turn.
    const recoveries = queries.filter((query) => query === CUSTOMER_TURN);
    expect(recoveries).toHaveLength(MAX_TRUSTED_QUERY_RECOVERIES_PER_TURN);
    expect(queries).toHaveLength(4);
  });

  it('does not recover when the runtime supplied no customer turn', async () => {
    const { executor, queries } = executorFor({});

    const result = await executor.execute(
      call('a rewrite'),
      context({ customerMessage: undefined }),
    );

    expect(queries).toHaveLength(1);
    expect(result.knowledgeDiagnostic?.origin).toBe('model_search');
  });

  it('does not recover on a customer turn too short to be a question', async () => {
    const { executor, queries } = executorFor({});

    await executor.execute(call('a rewrite'), context({ customerMessage: '  ?  ' }));

    expect(queries).toHaveLength(1);
  });

  it('keeps the recovery query within the bound the tool schema allows', async () => {
    const { executor, queries } = executorFor({});

    await executor.execute(call('a rewrite'), context({ customerMessage: 'x'.repeat(5_000) }));

    expect(queries[1]?.length).toBe(600);
  });
});

describe('a failing recovery falls back safely', () => {
  it('reports the existing failure behaviour when the recovery search throws', async () => {
    const searchBusinessKnowledge = vi
      .fn()
      .mockResolvedValueOnce(MODEL_QUERY_FLAT)
      .mockRejectedValueOnce(new Error('embedding provider unavailable'));
    const services = {
      requestHumanHelp: vi.fn().mockResolvedValue({ created: true }),
      searchBusinessKnowledge,
    } as unknown as AgentToolServices;
    const executor = new ControlledToolExecutor(veterinaryPack, services);

    const result = await executor.execute(call('a rewrite'), context());

    // The pre-existing failure path, unchanged: a bounded message, no sources, and the outcome the
    // runtime already knows how to turn into the deterministic no-knowledge reply.
    expect(result.execution.status).toBe('failed');
    expect(result.knowledgeOutcome).toBe('failed');
    expect(result.sources).toEqual([]);
  });
});
