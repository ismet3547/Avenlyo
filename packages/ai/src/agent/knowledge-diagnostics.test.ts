import { veterinaryPack } from '@avenlyo/industries';
import { describe, expect, it, vi } from 'vitest';

import { ControlledToolExecutor } from '../tools/executor';
import type { AgentToolServices } from '../tools/types';

import {
  evaluateKnowledgeReliability,
  normalizeKnowledgeQuery,
  MAX_AGENT_KNOWLEDGE_DIAGNOSTIC_MATCHES,
  MAX_AGENT_KNOWLEDGE_QUERY_LENGTH,
  MAX_AGENT_KNOWLEDGE_SOURCES,
} from './knowledge-reliability';
import type { AgentExecutionContext, KnowledgeSource } from './types';

/**
 * The diagnostic exists so a refused answer can be explained without guessing, and it is only worth
 * having if two things hold: it cannot disagree with the decision the model actually saw, and it
 * cannot carry anything that would make it a privacy problem. Both are asserted here.
 */

const DECISIONS = new Set([
  'strong',
  'comparative_winner',
  'rejected_below_minimum',
  'rejected_not_top',
  'rejected_insufficient_lead',
]);

function match(similarity: number, title = 'Page'): KnowledgeSource {
  return {
    content: `Secret page body for ${title} that must never appear in a diagnostic.`,
    similarity,
    sourceUrl: `https://clinic.test/${title.toLowerCase()}`,
    title,
  };
}

describe('the diagnostic cannot disagree with the decision', () => {
  it('reports exactly the sources that reached the model', () => {
    for (const set of [
      [],
      [match(0.44)],
      [match(0.65)],
      [match(0.573), match(0.422), match(0.296)],
      [match(0.46), match(0.44), match(0.41)],
      [match(0.62), match(0.36), match(0.35)],
      [match(0.3), match(0.02)],
      [match(0.9), match(0.88), match(0.86), match(0.84)],
    ]) {
      const { diagnostics, qualifyingSources } = evaluateKnowledgeReliability(set);
      expect(diagnostics.qualifiedCount).toBe(qualifyingSources.length);
    }
  });

  it('marks a strong top as strong and hands that same source over', () => {
    const { diagnostics, qualifyingSources } = evaluateKnowledgeReliability([
      match(0.62, 'Strong'),
      match(0.36, 'Weak'),
      match(0.35, 'Weaker'),
    ]);

    expect(diagnostics.matches[0]).toMatchObject({ decision: 'strong', rank: 1 });
    expect(qualifyingSources.map((source) => source.title)).toEqual(['Strong']);
    // The runners-up are recorded as refused, and refused for the right reason.
    expect(diagnostics.matches[1]?.decision).toBe('rejected_not_top');
    expect(diagnostics.matches[2]?.decision).toBe('rejected_not_top');
    expect(diagnostics.qualifiedCount).toBe(1);
  });

  it('marks a moderate clear winner as the comparative winner and hands over only it', () => {
    // The real staging shape.
    const { diagnostics, qualifyingSources } = evaluateKnowledgeReliability([
      match(0.573, 'Giris'),
      match(0.422, 'Hesap'),
      match(0.296, 'Unrelated'),
    ]);

    expect(diagnostics.matches[0]).toMatchObject({ decision: 'comparative_winner', rank: 1 });
    expect(diagnostics.matches[1]?.decision).toBe('rejected_not_top');
    expect(diagnostics.matches[2]?.decision).toBe('rejected_below_minimum');
    expect(qualifyingSources.map((source) => source.title)).toEqual(['Giris']);
  });

  it('explains a refused flat field as insufficient lead rather than a low score', () => {
    const { diagnostics, qualifyingSources } = evaluateKnowledgeReliability([
      match(0.46),
      match(0.44),
      match(0.41),
    ]);

    expect(diagnostics.matches[0]?.decision).toBe('rejected_insufficient_lead');
    expect(qualifyingSources).toEqual([]);
    expect(diagnostics.qualifiedCount).toBe(0);
  });

  it('explains a refused lone moderate match the same way', () => {
    const { diagnostics, qualifyingSources } = evaluateKnowledgeReliability([match(0.44)]);

    expect(diagnostics.matches[0]?.decision).toBe('rejected_insufficient_lead');
    expect(qualifyingSources).toEqual([]);
  });

  it('explains a weak field as below minimum', () => {
    const { diagnostics } = evaluateKnowledgeReliability([match(0.3), match(0.02)]);

    expect(diagnostics.matches.every((entry) => entry.decision === 'rejected_below_minimum')).toBe(
      true,
    );
  });
});

describe('the diagnostic is bounded and closed', () => {
  it('never describes more than the diagnostic cap', () => {
    const many = Array.from({ length: 12 }, (_unused, index) => match(0.9 - index * 0.01));
    const { diagnostics } = evaluateKnowledgeReliability(many);

    expect(diagnostics.matches).toHaveLength(MAX_AGENT_KNOWLEDGE_DIAGNOSTIC_MATCHES);
    // The count of what was retrieved is still truthful even though the detail is capped.
    expect(diagnostics.retrievedCount).toBe(12);
    expect(diagnostics.qualifiedCount).toBe(MAX_AGENT_KNOWLEDGE_SOURCES);
  });

  it('uses only the closed decision set, in rank order, with numeric bounded similarities', () => {
    const { diagnostics } = evaluateKnowledgeReliability([
      match(1.8),
      match(0.5),
      match(-3),
      match(0.42),
    ]);

    diagnostics.matches.forEach((entry, index) => {
      expect(DECISIONS.has(entry.decision)).toBe(true);
      expect(entry.rank).toBe(index + 1);
      expect(Number.isFinite(entry.similarity)).toBe(true);
      expect(entry.similarity).toBeGreaterThanOrEqual(0);
      expect(entry.similarity).toBeLessThanOrEqual(1);
    });
  });

  it('carries no identifying field at all', () => {
    const { diagnostics } = evaluateKnowledgeReliability([match(0.9, 'Confidential')]);
    const serialized = JSON.stringify(diagnostics);

    expect(serialized).not.toContain('Confidential');
    expect(serialized).not.toContain('clinic.test');
    expect(serialized).not.toContain('Secret page body');
    expect(Object.keys(diagnostics.matches[0]!).sort()).toEqual(['decision', 'rank', 'similarity']);
  });
});

describe('the executor diagnostic records the search without recording the words', () => {
  const context: AgentExecutionContext = {
    conversationId: '00000000-0000-4000-8000-000000000001',
    customerMessage: 'Nasil kayit olucam?',
    industryId: 'veterinary',
    locationId: '00000000-0000-4000-8000-000000000002',
    mode: 'test',
    organizationId: '00000000-0000-4000-8000-000000000003',
  };

  function executorFor(matches: readonly KnowledgeSource[]) {
    const services = {
      requestHumanHelp: vi.fn().mockResolvedValue({ created: true }),
      searchBusinessKnowledge: vi.fn().mockResolvedValue(matches),
    } as unknown as AgentToolServices;
    return new ControlledToolExecutor(veterinaryPack, services);
  }

  function call(query: string) {
    return {
      arguments: JSON.stringify({ query }),
      callId: 'fc_knowledge_1',
      name: 'search_business_knowledge',
    };
  }

  it('never persists the query, the customer turn, or any source text', async () => {
    const executor = executorFor([match(0.9, 'Confidential')]);

    const result = await executor.execute(
      call('a very distinctive model authored query string'),
      context,
    );
    const serialized = JSON.stringify(result.knowledgeDiagnostic);

    expect(serialized).not.toContain('distinctive model authored');
    expect(serialized).not.toContain('Nasil kayit olucam');
    expect(serialized).not.toContain('Confidential');
    expect(serialized).not.toContain('clinic.test');
    expect(serialized).not.toContain('Secret page body');
    // The tenant is not the diagnostic's business either.
    expect(serialized).not.toContain(context.organizationId);
    expect(serialized).not.toContain(context.locationId!);
  });

  it('records the query length instead of the query, bounded', async () => {
    const executor = executorFor([match(0.9)]);

    const result = await executor.execute(call('x'.repeat(50)), context);

    expect(result.knowledgeDiagnostic?.queryLength).toBe(50);
    expect(result.knowledgeDiagnostic!.queryLength).toBeLessThanOrEqual(
      MAX_AGENT_KNOWLEDGE_QUERY_LENGTH,
    );
  });

  it('knows when the model searched the customer question verbatim', async () => {
    const executor = executorFor([match(0.9)]);

    const same = await executor.execute(call('Nasil kayit olucam?'), context);
    expect(same.knowledgeDiagnostic?.queryMatchesCustomerTurn).toBe(true);

    // Case and surrounding whitespace are not a real difference.
    const padded = await executor.execute(call('  NASIL   kayit olucam?  '), context);
    expect(padded.knowledgeDiagnostic?.queryMatchesCustomerTurn).toBe(true);
  });

  it('knows when the model rewrote the question into something else', async () => {
    const executor = executorFor([match(0.9)]);

    const rewritten = await executor.execute(call('how do I register an account'), context);

    // This is the whole point of the field: it separates "the model asked something else" from
    // "retrieval is broken", which look identical from outside the process.
    expect(rewritten.knowledgeDiagnostic?.queryMatchesCustomerTurn).toBe(false);
  });

  it('reports no match with the customer turn when the runtime supplied none', async () => {
    const executor = executorFor([match(0.9)]);
    const withoutTurn: AgentExecutionContext = { ...context, customerMessage: undefined };

    const result = await executor.execute(call('anything at all'), withoutTurn);

    expect(result.knowledgeDiagnostic?.queryMatchesCustomerTurn).toBe(false);
  });

  it('reports whether the trusted-query recovery ran', async () => {
    // The field the first staging read was missing: without it a refused answer cannot be told
    // apart from a refused answer that already had its second chance.
    const noRecoveryNeeded = await executorFor([match(0.9)]).execute(call('kayit olma'), context);
    expect(noRecoveryNeeded.knowledgeDiagnostic?.usedTrustedQueryRetry).toBe(false);
  });

  it('agrees with the outcome the model was actually given', async () => {
    const reliable = await executorFor([match(0.62), match(0.36)]).execute(call('kayit olma'), context);
    expect(reliable.knowledgeDiagnostic?.knowledgeOutcome).toBe('reliable');
    expect(reliable.knowledgeDiagnostic?.qualifiedCount).toBe(reliable.sources.length);

    const refused = await executorFor([match(0.46), match(0.44)]).execute(call('kayit olma'), context);
    expect(refused.knowledgeDiagnostic?.knowledgeOutcome).toBe('empty_or_unreliable');
    expect(refused.knowledgeDiagnostic?.qualifiedCount).toBe(0);
    expect(refused.sources).toEqual([]);
  });
});

describe('query normalization', () => {
  it('ignores case and whitespace and nothing else', () => {
    expect(normalizeKnowledgeQuery('  Nasil   Kayit  Olucam? ')).toBe('nasil kayit olucam?');
    expect(normalizeKnowledgeQuery('a b')).not.toBe(normalizeKnowledgeQuery('ab'));
  });
});
