import type { KnowledgeSource } from './types';

/**
 * Whether retrieved knowledge is trustworthy enough to answer a customer from.
 *
 * Source-controlled and deterministic on purpose: the model never decides what counts as reliable,
 * and neither does the provider. This module is the whole trust decision for both the text agent
 * and the voice agent, so the two channels cannot drift into different answers about the same
 * corpus.
 *
 * ## Why this replaced a single 0.78 floor
 *
 * The original rule was one absolute cosine threshold, chosen as a conservative guess before there
 * was any retrieval to measure. Real staging retrieval measured it, and it was not conservative --
 * it was unreachable. Against a published Turkish site, the question "Hesabım yoksa ne
 * yapmalıyım?" returned:
 *
 *   0.573  "Giriş Yap"      -- contains "Hesabınız yok mu? Hemen Kayıt Olun"
 *   0.422  "Hesap Oluştur"
 *   0.296  a weaker, unrelated page
 *
 * The first two answer the question directly. All three were discarded, and the agent produced the
 * unknown-knowledge fallback while the operator could see the same results ranked correctly in the
 * knowledge search UI. `text-embedding-3-small` cosine similarity simply does not reach 0.78 for a
 * natural-language question against prose; that range belongs to near-duplicate text.
 *
 * ## The rule
 *
 * Lowering the number alone would trade one arbitrary constant for another, so the shape changed
 * too. A single absolute threshold cannot tell a clear winner from a flat, ambiguous field -- and
 * that distinction, not the raw score, is what separates "the corpus answers this" from "the corpus
 * contains nothing in particular about this".
 *
 * Two gates, in order:
 *
 * 1. **Floor.** Nothing below {@link MIN_AGENT_KNOWLEDGE_SIMILARITY} is ever shown to the model,
 *    whatever it leads by. Below roughly this level the text is not topically related at all, and a
 *    large lead over even weaker noise is still noise.
 *
 * 2. **Confidence, either way.** The best match qualifies if it is strong on its own
 *    ({@link STRONG_AGENT_KNOWLEDGE_SIMILARITY}), or if it leads the rest of the field by
 *    {@link MIN_AGENT_KNOWLEDGE_LEAD_RATIO}. A moderate score that clearly beats everything else is
 *    the corpus discriminating; the same score in a cluster of near-equals is the corpus shrugging.
 *
 * The lead is measured against the next-best match *overall*, not the next one above the floor:
 * "this beat everything else" is the signal, and it is strongest precisely when the runners-up are
 * poor. A sole match is treated as leading a field of nothing and rests on the floor alone.
 *
 * ## Why these constants are conservative
 *
 * They admit the staging evidence with margin to spare and nothing weaker. 0.573 over 0.422 is a
 * 1.36x lead against a required 1.25x. The 0.296 result is refused by the floor, so it is never
 * offered as supporting evidence for an answer the 0.573 result earned. A flat field -- the shape
 * of a query the corpus does not cover -- fails the lead test at any score below strong, which is
 * the hallucination guard the absolute floor was reaching for and missing.
 */

/**
 * Below this, a match is not treated as related to the question at all.
 *
 * Calibrated against observed `text-embedding-3-small` behaviour on real published pages, where
 * unrelated prose sits near 0.1-0.3 and genuinely relevant prose starts around 0.4. The staging
 * corpus put its one irrelevant result at 0.296 and its weakest *relevant* result at 0.422, so the
 * boundary between them is where this sits.
 */
export const MIN_AGENT_KNOWLEDGE_SIMILARITY = 0.35;

/** Strong enough to stand without any contrast: a direct, unambiguous match. */
export const STRONG_AGENT_KNOWLEDGE_SIMILARITY = 0.6;

/**
 * How far ahead of the field a moderate match must be to count as the corpus discriminating.
 *
 * A ratio rather than a difference, because it is only ever applied in the moderate band below
 * {@link STRONG_AGENT_KNOWLEDGE_SIMILARITY}, where proportional distance is the meaningful one. A
 * strong match short-circuits before this is consulted, so the ratio never has to behave sensibly
 * at the top of the scale.
 */
export const MIN_AGENT_KNOWLEDGE_LEAD_RATIO = 1.25;

/** Never hand the model an unbounded set; three sources is enough to answer from and to cite. */
export const MAX_AGENT_KNOWLEDGE_SOURCES = 3;

const MAX_SOURCE_CONTENT = 1_200;
const MAX_SOURCE_TITLE = 240;
const MAX_SOURCE_URL = 1_000;

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

/**
 * Ranks the matches this rule can reason about.
 *
 * The search RPC already orders by vector distance, so this is defensive rather than corrective --
 * but the ordering is the input to the lead test, and a rule that silently depends on a caller
 * sorting correctly is a rule that breaks quietly.
 */
function ranked(matches: readonly KnowledgeSource[]): readonly KnowledgeSource[] {
  return matches
    .filter((match) => Number.isFinite(match.similarity))
    .map((match) => ({ ...match, similarity: Math.max(0, Math.min(1, match.similarity)) }))
    .sort((left, right) => right.similarity - left.similarity);
}

/** The trust decision on its own, so it can be asserted directly and reused without the mapping. */
export function isKnowledgeReliable(matches: readonly KnowledgeSource[]): boolean {
  const scored = ranked(matches);
  const top = scored[0];
  if (!top || top.similarity < MIN_AGENT_KNOWLEDGE_SIMILARITY) return false;
  if (top.similarity >= STRONG_AGENT_KNOWLEDGE_SIMILARITY) return true;
  const runnerUp = scored[1];
  // No runner-up is a field of nothing to lead, so the floor is the only gate that applies.
  if (!runnerUp) return true;
  return top.similarity >= runnerUp.similarity * MIN_AGENT_KNOWLEDGE_LEAD_RATIO;
}

/**
 * The published matches that may be shown to the model, or nothing.
 *
 * Bounded and sanitised on the way out: at most {@link MAX_AGENT_KNOWLEDGE_SOURCES} sources, every
 * field length-capped, every similarity clamped into range. Whether a match is *published* is not
 * decided here and never could be -- the search RPC filters to `status = 'ready'` under the
 * caller's own tenant and location access, so drafts and archived documents are unreachable before
 * this function is ever called.
 */
export function reliableKnowledgeSources(
  matches: readonly KnowledgeSource[],
): readonly KnowledgeSource[] {
  if (!isKnowledgeReliable(matches)) return [];
  return ranked(matches)
    .filter((match) => match.similarity >= MIN_AGENT_KNOWLEDGE_SIMILARITY)
    .slice(0, MAX_AGENT_KNOWLEDGE_SOURCES)
    .map((match) => ({
      content: truncate(match.content, MAX_SOURCE_CONTENT),
      similarity: match.similarity,
      sourceUrl: match.sourceUrl ? truncate(match.sourceUrl, MAX_SOURCE_URL) : null,
      title: truncate(match.title, MAX_SOURCE_TITLE),
    }));
}
