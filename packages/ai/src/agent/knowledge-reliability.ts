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
 * One question is asked of each match, not of the result set: **did this source earn the right to
 * support an answer?** There are exactly two ways to earn it.
 *
 * 1. **Absolutely.** A match at or above {@link STRONG_AGENT_KNOWLEDGE_SIMILARITY} stands on its
 *    own. It needs no comparison, and several of them are the corpus agreeing rather than hedging.
 *
 * 2. **Comparatively.** A match in the moderate band -- at least
 *    {@link MIN_AGENT_KNOWLEDGE_SIMILARITY}, below strong -- earns it only by being the top result
 *    *and* leading the runner-up by {@link MIN_AGENT_KNOWLEDGE_LEAD_RATIO}. Only the top result can
 *    take this route, because beating the field is what the route is: a mid-table score that
 *    happens to out-rank the tail below it has not beaten anything.
 *
 * Nothing below {@link MIN_AGENT_KNOWLEDGE_SIMILARITY} qualifies by any route, whatever it leads
 * by. Below roughly that level the text is not topically related, and a large lead over even weaker
 * noise is still noise.
 *
 * The answer is reliable when at least one match qualifies, and the qualifying matches -- only
 * those -- are the ones the model sees. Trust and evidence are the same decision asked once.
 *
 * ## Two things this deliberately refuses
 *
 * **A lone moderate match is not a winner.** An earlier form of this rule accepted any above-floor
 * match that had no runner-up, on the reasoning that a field of one is led by definition. That is
 * backwards. A missing competitor is not comparative confirmation, it is the absence of any: it
 * usually means the tenant published one document, or the search returned one candidate, neither of
 * which says the match answers the question. A singleton now needs absolute strength, exactly like
 * any other match with nothing to prove itself against.
 *
 * **A qualifying top result does not qualify the rest.** The same earlier form decided reliability
 * from the top match and then handed the model everything above the floor. So a strong 0.62 could
 * drag a 0.36 and a 0.35 in with it as though they were supporting evidence, and a moderate winner
 * could bring along the very runner-up it had just been measured against. The runner-up is what
 * made the winner's lead meaningful; it did not thereby become an answer. Each source now stands or
 * falls on its own.
 *
 * ## Why these constants are conservative
 *
 * They admit the staging evidence and nothing weaker. 0.573 leads 0.422 by 1.36x against a required
 * 1.25x, so the page that answers the question reaches the model -- alone. The 0.422 page is real
 * enough to make that lead meaningful and not strong enough to answer on its own; the 0.296 result
 * is below the floor twice over. A flat field, which is the shape of a query the corpus does not
 * cover, produces no qualifying match at any score below strong. That is the hallucination guard
 * the original absolute floor was reaching for and missing.
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

/** How many ranked matches a diagnostic may describe. Bounded so a diagnostic can never grow. */
export const MAX_AGENT_KNOWLEDGE_DIAGNOSTIC_MATCHES = 5;

/**
 * Why one match did or did not earn the right to support an answer.
 *
 * A closed set on purpose. This is the only thing the diagnostic says about a match, and a free
 * string here would eventually carry a title, a URL, or a fragment of the page.
 */
export type KnowledgeMatchDecision =
  | 'strong'
  | 'comparative_winner'
  | 'rejected_below_minimum'
  | 'rejected_not_top'
  | 'rejected_insufficient_lead';

const QUALIFYING_DECISIONS: ReadonlySet<KnowledgeMatchDecision> = new Set([
  'strong',
  'comparative_winner',
]);

/** One ranked match, reduced to a rank, a number, and a verdict. Never any of its text. */
export interface KnowledgeMatchDiagnostic {
  readonly decision: KnowledgeMatchDecision;
  /** 1-based position after ranking. */
  readonly rank: number;
  readonly similarity: number;
}

/**
 * Everything the reliability decision is willing to say about itself.
 *
 * Deliberately carries no identity: no title, no URL, no content, no tenant. The diagnostic
 * question is "what numbers came back and what did the rule do with them", and nothing about a
 * source's identity is needed to answer it.
 */
export interface KnowledgeReliabilityDiagnostics {
  readonly matches: readonly KnowledgeMatchDiagnostic[];
  /** How many sources actually reached the model, after the cap. */
  readonly qualifiedCount: number;
  readonly retrievedCount: number;
}

export interface KnowledgeReliabilityEvaluation {
  readonly diagnostics: KnowledgeReliabilityDiagnostics;
  readonly qualifyingSources: readonly KnowledgeSource[];
}

/**
 * One knowledge search, described in numbers only.
 *
 * This answers exactly one question the product could not otherwise answer: *did the model search
 * the customer's actual question, and what numeric evidence came back?* Everything that would make
 * it useful for anything else -- the query text, the customer's words, page content, titles, URLs,
 * tenant identifiers -- is deliberately absent, so there is nothing here to leak and no reason to
 * guard a read path for it.
 *
 * `queryMatchesCustomerTurn` is the load-bearing field. False with a poor score set means the model
 * rewrote the question into something that retrieves badly; true with the same scores means
 * retrieval itself is the problem. Those need completely different fixes, and without this flag
 * they are indistinguishable from outside the process.
 */
export interface KnowledgeSearchDiagnostic {
  readonly knowledgeOutcome: 'empty_or_unreliable' | 'failed' | 'reliable';
  readonly matches: readonly KnowledgeMatchDiagnostic[];
  readonly qualifiedCount: number;
  /** Length only. The query itself is never recorded. */
  readonly queryLength: number;
  readonly queryMatchesCustomerTurn: boolean;
  readonly retrievedCount: number;
  /** Already-safe identifier the tool layer uses; carries no customer or tenant data. */
  readonly toolCallId: string;
}

/** Upper bound on the recorded length, so the field stays a small integer whatever arrives. */
export const MAX_AGENT_KNOWLEDGE_QUERY_LENGTH = 4_096;

/**
 * Comparison form for "is this the customer's own question?".
 *
 * Case and whitespace are not meaningful differences here. Nothing locale-specific is applied:
 * Turkish dotted/dotless I would make this answer depend on the host's locale, and a diagnostic
 * that changes meaning by machine is worse than a slightly conservative one.
 */
export function normalizeKnowledgeQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

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

/**
 * Judges one ranked match, and says why.
 *
 * The verdict and the reason are produced together because they are the same computation. A
 * diagnostic derived from a second, parallel implementation of the rule would be worse than no
 * diagnostic at all: it would be believed, and it would drift.
 */
function decide(
  similarity: number,
  index: number,
  topLeadsTheField: boolean,
): KnowledgeMatchDecision {
  if (similarity < MIN_AGENT_KNOWLEDGE_SIMILARITY) return 'rejected_below_minimum';
  if (similarity >= STRONG_AGENT_KNOWLEDGE_SIMILARITY) return 'strong';
  // Moderate. Only the top match can take the comparative route, because beating the field is what
  // that route is; a mid-table score out-ranking the tail below it has not beaten anything.
  if (index !== 0) return 'rejected_not_top';
  return topLeadsTheField ? 'comparative_winner' : 'rejected_insufficient_lead';
}

/**
 * The one evaluation. Everything else in this module delegates to it.
 *
 * Trust and observability come out of the same pass, so the diagnostic can never disagree with what
 * the model was actually given -- which is the property that makes the diagnostic worth reading.
 */
export function evaluateKnowledgeReliability(
  matches: readonly KnowledgeSource[],
): KnowledgeReliabilityEvaluation {
  const scored = ranked(matches);
  const top = scored[0];

  // `scored[1]` absent means there was nothing to out-rank, and nothing to out-rank is not a lead,
  // so a lone moderate match falls through to the absolute test and is refused there.
  const runnerUp = scored[1];
  const topLeadsTheField =
    top !== undefined &&
    runnerUp !== undefined &&
    top.similarity >= runnerUp.similarity * MIN_AGENT_KNOWLEDGE_LEAD_RATIO;

  const decisions = scored.map((match, index) => decide(match.similarity, index, topLeadsTheField));
  const qualifyingSources = scored
    .filter((_match, index) => QUALIFYING_DECISIONS.has(decisions[index]!))
    .slice(0, MAX_AGENT_KNOWLEDGE_SOURCES)
    .map((match) => ({
      content: truncate(match.content, MAX_SOURCE_CONTENT),
      similarity: match.similarity,
      sourceUrl: match.sourceUrl ? truncate(match.sourceUrl, MAX_SOURCE_URL) : null,
      title: truncate(match.title, MAX_SOURCE_TITLE),
    }));

  return {
    diagnostics: {
      matches: scored.slice(0, MAX_AGENT_KNOWLEDGE_DIAGNOSTIC_MATCHES).map((match, index) => ({
        decision: decisions[index]!,
        rank: index + 1,
        similarity: match.similarity,
      })),
      // What actually reached the model, not what could have: the cap is part of the answer.
      qualifiedCount: qualifyingSources.length,
      retrievedCount: scored.length,
    },
    qualifyingSources,
  };
}

/** The trust decision on its own, so it can be asserted directly and reused without the mapping. */
export function isKnowledgeReliable(matches: readonly KnowledgeSource[]): boolean {
  return evaluateKnowledgeReliability(matches).qualifyingSources.length > 0;
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
  return evaluateKnowledgeReliability(matches).qualifyingSources;
}
