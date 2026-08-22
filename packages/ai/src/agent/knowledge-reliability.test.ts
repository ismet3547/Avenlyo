import { describe, expect, it } from 'vitest';

import {
  isKnowledgeReliable,
  reliableKnowledgeSources,
  MAX_AGENT_KNOWLEDGE_SOURCES,
  MIN_AGENT_KNOWLEDGE_LEAD_RATIO,
  MIN_AGENT_KNOWLEDGE_SIMILARITY,
  STRONG_AGENT_KNOWLEDGE_SIMILARITY,
} from './knowledge-reliability';
import type { KnowledgeSource } from './types';

/**
 * The trust rule, exercised on score shapes rather than on prose.
 *
 * Nothing here calls OpenAI or a database. The similarities are the ones real retrieval produced,
 * which is the only part of the pipeline this rule reads.
 */

function match(similarity: number, title = 'Page'): KnowledgeSource {
  return {
    content: 'Published page text that the agent may answer from.',
    similarity,
    sourceUrl: `https://clinic.test/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
  };
}

describe('the staging regression', () => {
  // Measured on real Hetzner staging against a published Turkish site. The question
  // "Hesabım yoksa ne yapmalıyım?" ("what should I do if I don't have an account?") retrieved
  // these, correctly ranked, and the 0.78 floor discarded all of them -- so the agent answered
  // "I don't have reliable information about that yet" while the same results were visibly
  // correct in the knowledge search UI.
  const staging = [
    match(0.573, 'Giris Yap'),
    match(0.422, 'Hesap Olustur'),
    match(0.296, 'Unrelated Page'),
  ];

  it('accepts the clear winner the old floor rejected', () => {
    expect(isKnowledgeReliable(staging)).toBe(true);
  });

  it('offers the relevant pages and drops the weak one', () => {
    const sources = reliableKnowledgeSources(staging);

    // 0.296 is below the floor: it is not supporting evidence for an answer the 0.573 page earned.
    expect(sources.map((source) => source.title)).toEqual(['Giris Yap', 'Hesap Olustur']);
  });

  it('would have been refused by the floor it replaced', () => {
    // Pins why the constant moved. Every score above is under 0.78, so any rule shaped like the
    // old one rejects this set no matter how it is tuned within the same shape.
    expect(staging.every((source) => source.similarity < 0.78)).toBe(true);
  });

  it('clears the required lead with margin rather than by a hair', () => {
    const [top, second] = staging;
    expect(top!.similarity / second!.similarity).toBeGreaterThan(MIN_AGENT_KNOWLEDGE_LEAD_RATIO);
  });
});

describe('a clear winner', () => {
  it('is trusted at a moderate score when it leads the field', () => {
    expect(isKnowledgeReliable([match(0.52), match(0.33), match(0.21)])).toBe(true);
  });

  it('is trusted when nothing else came back at all', () => {
    // A field of one is led by definition, so only the floor applies.
    expect(isKnowledgeReliable([match(0.44)])).toBe(true);
    expect(isKnowledgeReliable([match(0.2)])).toBe(false);
  });

  it('is trusted on absolute strength even inside a tight cluster', () => {
    // A strong match does not have to out-run its neighbours: several pages saying the same true
    // thing is the corpus agreeing, not the corpus hedging.
    expect(isKnowledgeReliable([match(0.81), match(0.79), match(0.78)])).toBe(true);
  });
});

describe('an ambiguous or weak field', () => {
  it('rejects a flat cluster of similar moderate scores', () => {
    // The shape of a question the corpus does not actually cover: several pages equally, mildly
    // related, none of them the answer.
    expect(isKnowledgeReliable([match(0.46), match(0.44), match(0.41)])).toBe(false);
    expect(reliableKnowledgeSources([match(0.46), match(0.44), match(0.41)])).toEqual([]);
  });

  it('rejects everything below the floor however large the lead', () => {
    // 0.30 over 0.02 is a fifteen-fold lead over noise, and is still noise.
    expect(isKnowledgeReliable([match(0.3), match(0.02)])).toBe(false);
  });

  it('rejects an empty result set', () => {
    expect(isKnowledgeReliable([])).toBe(false);
    expect(reliableKnowledgeSources([])).toEqual([]);
  });

  it('rejects scores that are not real numbers', () => {
    expect(isKnowledgeReliable([match(Number.NaN), match(Number.POSITIVE_INFINITY)])).toBe(false);
  });
});

describe('the boundaries are exact', () => {
  it('accepts exactly at the floor when the lead is clear, and refuses just below', () => {
    const floor = MIN_AGENT_KNOWLEDGE_SIMILARITY;
    expect(isKnowledgeReliable([match(floor), match(floor / 2)])).toBe(true);
    expect(isKnowledgeReliable([match(floor - 0.01), match(0.01)])).toBe(false);
  });

  it('accepts exactly at the strong threshold with no lead at all', () => {
    const strong = STRONG_AGENT_KNOWLEDGE_SIMILARITY;
    expect(isKnowledgeReliable([match(strong), match(strong)])).toBe(true);
    expect(isKnowledgeReliable([match(strong - 0.01), match(strong - 0.01)])).toBe(false);
  });

  it('accepts exactly at the required lead ratio and refuses just under it', () => {
    const runnerUp = 0.4;
    expect(isKnowledgeReliable([match(runnerUp * MIN_AGENT_KNOWLEDGE_LEAD_RATIO), match(runnerUp)]))
      .toBe(true);
    expect(
      isKnowledgeReliable([match(runnerUp * MIN_AGENT_KNOWLEDGE_LEAD_RATIO - 0.001), match(runnerUp)]),
    ).toBe(false);
  });

  it('keeps the guard meaningfully below the range real retrieval reaches', () => {
    // Guards against the failure this replaced: a floor set above what the embedding model
    // actually produces for natural questions is not a strict rule, it is an unreachable one.
    expect(MIN_AGENT_KNOWLEDGE_SIMILARITY).toBeGreaterThan(0.25);
    expect(MIN_AGENT_KNOWLEDGE_SIMILARITY).toBeLessThan(0.42);
    expect(STRONG_AGENT_KNOWLEDGE_SIMILARITY).toBeGreaterThan(MIN_AGENT_KNOWLEDGE_SIMILARITY);
    expect(MIN_AGENT_KNOWLEDGE_LEAD_RATIO).toBeGreaterThan(1);
  });
});

describe('what reaches the model is bounded and sanitised', () => {
  it('never returns more than the source cap', () => {
    const many = [match(0.9, 'A'), match(0.88, 'B'), match(0.86, 'C'), match(0.84, 'D')];

    expect(reliableKnowledgeSources(many)).toHaveLength(MAX_AGENT_KNOWLEDGE_SOURCES);
  });

  it('truncates content, titles, and urls', () => {
    const [source] = reliableKnowledgeSources([
      {
        content: 'x'.repeat(5_000),
        similarity: 0.9,
        sourceUrl: `https://clinic.test/${'y'.repeat(5_000)}`,
        title: 'z'.repeat(1_000),
      },
    ]);

    expect(source!.content.length).toBe(1_200);
    expect(source!.title.length).toBe(240);
    expect(source!.sourceUrl!.length).toBe(1_000);
  });

  it('clamps a similarity outside the unit range', () => {
    const [source] = reliableKnowledgeSources([match(1.4), match(0.1)]);

    expect(source!.similarity).toBe(1);
  });

  it('keeps a null source url null', () => {
    const [source] = reliableKnowledgeSources([{ ...match(0.9), sourceUrl: null }]);

    expect(source!.sourceUrl).toBeNull();
  });

  it('ranks defensively rather than trusting the caller to sort', () => {
    // The search RPC orders by vector distance, but the lead test reads position 0 and position 1.
    // A rule that silently depended on someone else sorting would fail quietly, not loudly.
    const outOfOrder = [match(0.3, 'Weak'), match(0.62, 'Best'), match(0.36, 'Middle')];

    expect(reliableKnowledgeSources(outOfOrder).map((source) => source.title)).toEqual([
      'Best',
      'Middle',
    ]);
  });
});
