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
 *
 * Every case asserts both halves of the decision -- whether the answer is reliable, and which
 * sources reach the model -- because they are the same decision and the defect these tests were
 * rewritten for was the two disagreeing.
 */

function match(similarity: number, title = 'Page'): KnowledgeSource {
  return {
    content: 'Published page text that the agent may answer from.',
    similarity,
    sourceUrl: `https://clinic.test/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
  };
}

function titles(matches: readonly KnowledgeSource[]): readonly string[] {
  return reliableKnowledgeSources(matches).map((source) => source.title);
}

describe('the staging regression', () => {
  // Measured on real Hetzner staging against a published Turkish site. The question
  // "Hesabım yoksa ne yapmalıyım?" ("what should I do if I don't have an account?") retrieved
  // these, correctly ranked, and the original 0.78 floor discarded all of them -- so the agent
  // answered "I don't have reliable information about that yet" while the same results were
  // visibly correct in the knowledge search UI.
  const staging = [
    match(0.573, 'Giris Yap'),
    match(0.422, 'Hesap Olustur'),
    match(0.296, 'Unrelated Page'),
  ];

  it('accepts the clear winner the old floor rejected', () => {
    expect(isKnowledgeReliable(staging)).toBe(true);
  });

  it('sends only the page that actually won', () => {
    // The 0.422 page is what made the winner's lead meaningful. That is evidence about the
    // *winner*, not an answer in its own right, and it is below strong on its own terms.
    expect(titles(staging)).toEqual(['Giris Yap']);
  });

  it('would have been refused by the floor it replaced', () => {
    // Pins why the constant moved. Every score here is under 0.78, so any rule shaped like the
    // original one rejects this set no matter how it is tuned within the same shape.
    expect(staging.every((source) => source.similarity < 0.78)).toBe(true);
  });

  it('clears the required lead with margin rather than by a hair', () => {
    const [top, second] = staging;
    expect(top!.similarity / second!.similarity).toBeGreaterThan(MIN_AGENT_KNOWLEDGE_LEAD_RATIO);
  });
});

describe('a moderate match needs comparative confirmation', () => {
  it('is trusted when it clearly leads the field, and answers alone', () => {
    const set = [match(0.52, 'Winner'), match(0.33, 'Second'), match(0.21, 'Third')];

    expect(isKnowledgeReliable(set)).toBe(true);
    expect(titles(set)).toEqual(['Winner']);
  });

  it('is refused when it is one of a flat cluster', () => {
    // The shape of a question the corpus does not actually cover: several pages equally, mildly
    // related, none of them the answer.
    const cluster = [match(0.46), match(0.44), match(0.41)];

    expect(isKnowledgeReliable(cluster)).toBe(false);
    expect(reliableKnowledgeSources(cluster)).toEqual([]);
  });

  it('is refused when it is alone, however far above the floor', () => {
    // The correction this suite was rewritten for. A missing competitor is not comparative
    // confirmation, it is the absence of any -- usually a tenant with one published document, or a
    // search that returned one candidate. Neither says the match answers the question.
    expect(isKnowledgeReliable([match(0.44)])).toBe(false);
    expect(reliableKnowledgeSources([match(0.44)])).toEqual([]);
    expect(isKnowledgeReliable([match(0.36)])).toBe(false);
    // Right up against the strong threshold and still alone: still refused.
    expect(isKnowledgeReliable([match(STRONG_AGENT_KNOWLEDGE_SIMILARITY - 0.001)])).toBe(false);
  });

  it('is refused mid-table even when it out-ranks the tail below it', () => {
    // 0.44 leads 0.30 by 1.47x, but it is not the top result. Beating the field is what the
    // comparative route is; out-ranking the leftovers is not beating anything.
    const set = [match(0.46, 'Top'), match(0.44, 'Middle'), match(0.3, 'Tail')];

    expect(isKnowledgeReliable(set)).toBe(false);
    expect(titles(set)).toEqual([]);
  });
});

describe('a strong match stands on its own', () => {
  it('is trusted alone', () => {
    expect(isKnowledgeReliable([match(0.65)])).toBe(true);
    expect(titles([match(0.65, 'Direct')])).toEqual(['Direct']);
  });

  it('does not drag weak runners-up along with it', () => {
    // The second half of the correction. A strong top result used to make everything above the
    // floor look like supporting evidence, so a 0.36 and a 0.35 reached the model as though the
    // corpus had three answers.
    const set = [match(0.62, 'Strong'), match(0.36, 'Weak'), match(0.35, 'Weaker')];

    expect(isKnowledgeReliable(set)).toBe(true);
    expect(titles(set)).toEqual(['Strong']);
  });

  it('is trusted inside a tight cluster of other strong matches', () => {
    // Several pages saying the same true thing is the corpus agreeing, not hedging -- and each of
    // them earned its place absolutely, so each may support the answer.
    const cluster = [match(0.81, 'A'), match(0.79, 'B'), match(0.78, 'C')];

    expect(isKnowledgeReliable(cluster)).toBe(true);
    expect(titles(cluster)).toEqual(['A', 'B', 'C']);
  });

  it('carries only its strong companions, not the moderate ones', () => {
    const mixed = [match(0.72, 'Strong'), match(0.61, 'AlsoStrong'), match(0.4, 'Moderate')];

    expect(titles(mixed)).toEqual(['Strong', 'AlsoStrong']);
  });
});

describe('a weak field is refused', () => {
  it('rejects everything below the floor however large the lead', () => {
    // 0.30 over 0.02 is a fifteen-fold lead over noise, and is still noise.
    expect(isKnowledgeReliable([match(0.3), match(0.02)])).toBe(false);
    expect(reliableKnowledgeSources([match(0.3), match(0.02)])).toEqual([]);
  });

  it('rejects an empty result set', () => {
    expect(isKnowledgeReliable([])).toBe(false);
    expect(reliableKnowledgeSources([])).toEqual([]);
  });

  it('rejects scores that are not real numbers', () => {
    expect(isKnowledgeReliable([match(Number.NaN), match(Number.POSITIVE_INFINITY)])).toBe(false);
  });

  it('ignores a non-finite score rather than letting it rank first', () => {
    // A NaN dropped into the set must not become the top match and take the comparative route.
    const set = [match(Number.NaN, 'Broken'), match(0.44, 'Moderate')];

    expect(isKnowledgeReliable(set)).toBe(false);
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
    expect(
      isKnowledgeReliable([match(runnerUp * MIN_AGENT_KNOWLEDGE_LEAD_RATIO), match(runnerUp)]),
    ).toBe(true);
    expect(
      isKnowledgeReliable([
        match(runnerUp * MIN_AGENT_KNOWLEDGE_LEAD_RATIO - 0.001),
        match(runnerUp),
      ]),
    ).toBe(false);
  });

  it('treats a zero-scoring runner-up as a real comparison rather than dividing by it', () => {
    expect(isKnowledgeReliable([match(0.4), match(0)])).toBe(true);
    expect(titles([match(0.4, 'Winner'), match(0, 'Nothing')])).toEqual(['Winner']);
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

    expect(titles(outOfOrder)).toEqual(['Best']);
  });

  it('agrees with itself about reliability and evidence', () => {
    // The invariant the two functions exist to share: sources are non-empty exactly when the
    // answer is reliable. A disagreement here is how weak runners-up reached the model before.
    for (const set of [
      [],
      [match(0.44)],
      [match(0.65)],
      [match(0.573), match(0.422), match(0.296)],
      [match(0.46), match(0.44), match(0.41)],
      [match(0.62), match(0.36), match(0.35)],
      [match(0.3), match(0.02)],
    ]) {
      expect(reliableKnowledgeSources(set).length > 0).toBe(isKnowledgeReliable(set));
    }
  });
});
