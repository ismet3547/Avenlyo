import type { CustomerDirectoryRow } from '@avenlyo/database';

/**
 * The customer search state machine.
 *
 * This lives apart from the component because the interesting behaviour is not the markup, it is
 * which predicate a request carries. A keyset cursor belongs to the query that produced it, so
 * pairing it with a different search term returns rows from one predicate and appends them to
 * results from another. Reading the live input value at request time does exactly that whenever
 * somebody edits the field and then clicks "Show more" without submitting.
 *
 * The fix is to keep the draft and the submitted term as separate facts, and to build every request
 * from the submitted one.
 */

export interface SearchCursor {
  readonly identifier: string;
  readonly timestamp: string;
}

export interface SearchState {
  /** What is currently typed. Changes freely and influences nothing until submitted. */
  readonly draftTerm: string;
  /** The term that produced `customers` and `cursor`. Null when no search is active. */
  readonly submittedTerm: string | null;
  readonly customers: readonly CustomerDirectoryRow[];
  readonly cursor: SearchCursor | null;
  readonly status: 'empty' | 'error' | 'idle' | 'ok';
}

export const initialSearchState: SearchState = {
  cursor: null,
  customers: [],
  draftTerm: '',
  status: 'idle',
  submittedTerm: null,
};

/** Mirrors the bound the action and the database both enforce. */
export const MINIMUM_SEARCH_LENGTH = 2;

export type SearchEvent =
  | { readonly type: 'draft'; readonly value: string }
  | { readonly type: 'submit' }
  | { readonly type: 'clear' }
  | {
      readonly type: 'result';
      readonly append: boolean;
      readonly customers: readonly CustomerDirectoryRow[];
      readonly cursor: SearchCursor | null;
      readonly status: 'empty' | 'error' | 'ok';
      /** The term this response was requested with, so a stale reply cannot overwrite a newer one. */
      readonly term: string;
    };

export function normalizeTerm(value: string): string {
  return value.trim();
}

/** True when a search is active and its results should replace the directory listing. */
export function isSearchActive(state: SearchState): boolean {
  return state.submittedTerm !== null;
}

export function searchReducer(state: SearchState, event: SearchEvent): SearchState {
  switch (event.type) {
    case 'draft':
      // Typing never touches the submitted term, so it cannot change what "Show more" asks for.
      return { ...state, draftTerm: event.value };

    case 'submit': {
      const term = normalizeTerm(state.draftTerm);
      // Too short to be a search: fall back to the directory rather than querying.
      if (term.length < MINIMUM_SEARCH_LENGTH)
        return { ...initialSearchState, draftTerm: state.draftTerm };
      // A new predicate starts over: no cursor, and previous rows are replaced rather than mixed.
      return { ...state, cursor: null, customers: [], status: 'idle', submittedTerm: term };
    }

    case 'clear':
      return initialSearchState;

    case 'result': {
      // A response for a term that is no longer the submitted one is discarded. Without this, a
      // slow first request could land after a second search and overwrite it.
      if (event.term !== state.submittedTerm) return state;
      const customers = event.append
        ? dedupe([...state.customers, ...event.customers])
        : event.customers;
      return { ...state, cursor: event.cursor, customers, status: event.status };
    }

    default:
      return state;
  }
}

/**
 * Keyset paging should not repeat a row, but a duplicated response must not render the same
 * customer twice either. This defends the view without inventing a client-side pagination model:
 * order and page boundaries still come from the database.
 */
function dedupe(rows: readonly CustomerDirectoryRow[]): readonly CustomerDirectoryRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.contact_id)) return false;
    seen.add(row.contact_id);
    return true;
  });
}

export interface SearchRequest {
  readonly cursor: SearchCursor | null;
  readonly term: string;
}

/**
 * The exact payload for a request, built from submitted state only.
 *
 * `submit` starts a predicate from its first page. `more` continues the predicate that produced the
 * current cursor. Neither reads the draft, which is what makes an unsubmitted edit inert.
 */
export function searchRequest(state: SearchState, mode: 'more' | 'submit'): SearchRequest | null {
  if (mode === 'submit') {
    const term = normalizeTerm(state.draftTerm);
    return term.length >= MINIMUM_SEARCH_LENGTH ? { cursor: null, term } : null;
  }
  if (state.submittedTerm === null || state.cursor === null) return null;
  return { cursor: state.cursor, term: state.submittedTerm };
}
