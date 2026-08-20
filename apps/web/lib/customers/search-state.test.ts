import type { CustomerDirectoryRow } from '@avenlyo/database';
import { describe, expect, it } from 'vitest';

import {
  initialSearchState,
  isSearchActive,
  searchReducer,
  searchRequest,
  type SearchEvent,
  type SearchState,
} from './search-state';

/**
 * The customer search state machine.
 *
 * The behaviour that matters is which predicate a request carries. A keyset cursor belongs to the
 * query that produced it, so pairing it with a different term returns rows from one predicate and
 * appends them to results from another — and reading the live input at request time does exactly
 * that whenever somebody edits the field and clicks "Show more" without submitting.
 */

const ALICE_PHONE = '+15551234567';
const BOB_EMAIL = 'customer-secret@example.test';

function customer(id: string, name: string): CustomerDirectoryRow {
  return {
    appointment_count: 0,
    call_count: 0,
    contact_id: id,
    conversation_count: 1,
    display_name: name,
    email: null,
    first_activity_at: '2026-08-01T00:00:00.000Z',
    first_name: name,
    last_activity_at: '2026-08-19T00:00:00.000Z',
    last_name: null,
    lead_status: null,
    phone: null,
    sms_opted_out: false,
  };
}

const ALICE_ONE = customer('11111111-1111-4111-8111-111111111111', 'Alice One');
const ALICE_TWO = customer('11111111-1111-4111-8111-111111111112', 'Alice Two');
const BOB_ONE = customer('22222222-2222-4222-8222-222222222221', 'Bob One');

const CURSOR_A = { identifier: ALICE_ONE.contact_id, timestamp: '2026-08-19T00:00:00.000Z' };

function apply(state: SearchState, ...events: readonly SearchEvent[]): SearchState {
  return events.reduce(searchReducer, state);
}

/** Submits a term and receives one page, which is the setup most scenarios start from. */
function searched(term: string, rows: readonly CustomerDirectoryRow[], cursor = CURSOR_A) {
  return apply(
    initialSearchState,
    { type: 'draft', value: term },
    { type: 'submit' },
    { append: false, customers: rows, cursor, status: 'ok', term, type: 'result' },
  );
}

describe('A. the directory is the default view', () => {
  it('starts with no active search', () => {
    expect(isSearchActive(initialSearchState)).toBe(false);
    expect(initialSearchState.customers).toEqual([]);
    expect(initialSearchState.submittedTerm).toBeNull();
  });

  it('typing alone does not activate a search', () => {
    const typed = apply(initialSearchState, { type: 'draft', value: 'Ali' });
    expect(isSearchActive(typed)).toBe(false);
    expect(typed.draftTerm).toBe('Ali');
  });

  it('refuses to search on a term too short to be one', () => {
    const attempted = apply(initialSearchState, { type: 'draft', value: 'a' }, { type: 'submit' });
    expect(isSearchActive(attempted)).toBe(false);
    expect(searchRequest(attempted, 'submit')).toBeNull();
  });
});

describe('B and C. submitting replaces the directory view', () => {
  it('activates the search view for a phone term', () => {
    const state = searched(ALICE_PHONE, [ALICE_ONE]);
    expect(isSearchActive(state)).toBe(true);
    expect(state.submittedTerm).toBe(ALICE_PHONE);
    expect(state.customers).toEqual([ALICE_ONE]);
  });

  it('activates the search view for an email term', () => {
    const state = searched(BOB_EMAIL, [BOB_ONE]);
    expect(isSearchActive(state)).toBe(true);
    expect(state.submittedTerm).toBe(BOB_EMAIL);
  });

  it('trims the submitted term so the request matches what the action normalizes', () => {
    const state = searched('  Alice  ', [ALICE_ONE]);
    expect(state.submittedTerm).toBe('Alice');
  });
});

describe('D. paging stays bound to the submitted term', () => {
  it('continues Alice even after the field is edited to Bob', () => {
    // The reported bug: editing the input changed the predicate that "Show more" used, so Bob was
    // queried with Alice's cursor and the rows were appended to Alice's list.
    const afterAlice = searched('Alice', [ALICE_ONE]);
    const edited = apply(afterAlice, { type: 'draft', value: 'Bob' });

    const request = searchRequest(edited, 'more');

    expect(request).toEqual({ cursor: CURSOR_A, term: 'Alice' });
    expect(request?.term).not.toBe('Bob');
  });

  it('appends the next Alice page to the existing rows', () => {
    const afterAlice = searched('Alice', [ALICE_ONE]);
    const paged = apply(afterAlice, {
      append: true,
      customers: [ALICE_TWO],
      cursor: null,
      status: 'ok',
      term: 'Alice',
      type: 'result',
    });

    expect(paged.customers).toEqual([ALICE_ONE, ALICE_TWO]);
    expect(paged.cursor).toBeNull();
  });

  it('offers no continuation when the database returned no cursor', () => {
    const exhausted = searched('Alice', [ALICE_ONE], null as never);
    expect(searchRequest(exhausted, 'more')).toBeNull();
  });
});

describe('E. a new term starts a new predicate', () => {
  it('drops the previous cursor when a different term is submitted', () => {
    const afterAlice = searched('Alice', [ALICE_ONE]);
    const submittedBob = apply(afterAlice, { type: 'draft', value: 'Bob' }, { type: 'submit' });

    expect(submittedBob.submittedTerm).toBe('Bob');
    expect(submittedBob.cursor).toBeNull();
    expect(searchRequest(submittedBob, 'submit')).toEqual({ cursor: null, term: 'Bob' });
  });

  it('replaces the previous rows rather than mixing two predicates', () => {
    const afterAlice = searched('Alice', [ALICE_ONE, ALICE_TWO]);
    const bobResults = apply(
      afterAlice,
      { type: 'draft', value: 'Bob' },
      { type: 'submit' },
      {
        append: false,
        customers: [BOB_ONE],
        cursor: null,
        status: 'ok',
        term: 'Bob',
        type: 'result',
      },
    );

    expect(bobResults.customers).toEqual([BOB_ONE]);
    expect(bobResults.customers).not.toContainEqual(ALICE_ONE);
  });

  it('discards a slow response for a term that is no longer submitted', () => {
    // Alice's request lands after Bob was submitted. Applying it would show Alice's rows under
    // Bob's term, which is the same mixing bug arriving by a different route.
    const submittedBob = apply(
      searched('Alice', [ALICE_ONE]),
      { type: 'draft', value: 'Bob' },
      { type: 'submit' },
    );
    const stale = apply(submittedBob, {
      append: false,
      customers: [ALICE_TWO],
      cursor: CURSOR_A,
      status: 'ok',
      term: 'Alice',
      type: 'result',
    });

    expect(stale).toEqual(submittedBob);
    expect(stale.customers).toEqual([]);
  });
});

describe('F. clearing restores the directory', () => {
  it('removes the search state entirely', () => {
    const cleared = apply(searched('Alice', [ALICE_ONE]), { type: 'clear' });

    expect(cleared).toEqual(initialSearchState);
    expect(isSearchActive(cleared)).toBe(false);
    expect(cleared.draftTerm).toBe('');
    expect(cleared.customers).toEqual([]);
  });

  it('treats submitting an emptied field as clearing', () => {
    const emptied = apply(
      searched('Alice', [ALICE_ONE]),
      { type: 'draft', value: '' },
      { type: 'submit' },
    );
    expect(isSearchActive(emptied)).toBe(false);
  });
});

describe('paging never repeats a customer', () => {
  it('drops a duplicate row if a response is somehow repeated', () => {
    // Keyset paging should not repeat a row; this defends the view without overriding database
    // ordering or page boundaries.
    const afterAlice = searched('Alice', [ALICE_ONE]);
    const repeated = apply(afterAlice, {
      append: true,
      customers: [ALICE_ONE, ALICE_TWO],
      cursor: null,
      status: 'ok',
      term: 'Alice',
      type: 'result',
    });

    expect(repeated.customers).toEqual([ALICE_ONE, ALICE_TWO]);
  });
});

describe('the search term never becomes a URL', () => {
  it('appears in no state field that a link is built from', () => {
    const state = searched(ALICE_PHONE, [ALICE_ONE]);
    // The only navigable value the search view produces is a contact UUID.
    const linkTargets = state.customers.map((row) => `/dashboard/customers/${row.contact_id}`);
    for (const target of linkTargets) {
      expect(target).not.toContain(ALICE_PHONE);
      expect(target).not.toContain(encodeURIComponent(ALICE_PHONE));
    }
    // The cursor is a timestamp and a UUID, so continuing a search carries no customer content.
    expect(JSON.stringify(state.cursor)).not.toContain(ALICE_PHONE);
  });
});
