import { describe, expect, it } from 'vitest';

import {
  safePageCursor,
  safeSearchTerm,
  safeTimelineCursor,
  safeTimestamp,
  safeUuid,
} from './input';

/**
 * External input for customer history routes.
 *
 * Every one of these values arrives from a URL, so the rule is that malformed input becomes the
 * same "unavailable" outcome as a foreign or nonexistent identifier — never a database error, and
 * never a signal about which of those it was.
 */
describe('route identifiers', () => {
  it('accepts a well-formed identifier', () => {
    expect(safeUuid('c6000000-0000-4000-8000-000000000001')).toBe(
      'c6000000-0000-4000-8000-000000000001',
    );
  });

  it('rejects anything that is not one', () => {
    for (const hostile of [
      'not-a-uuid',
      '',
      null,
      undefined,
      "1' or '1'='1",
      '../../etc/passwd',
      'c6000000-0000-4000-8000',
      'c6000000-0000-4000-8000-00000000000g',
    ]) {
      expect(safeUuid(hostile)).toBeNull();
    }
  });
});

describe('keyset cursors', () => {
  const AT = '2026-08-19T10:00:00.000Z';
  const ID = 'c6000000-0000-4000-8000-000000000001';

  it('accepts a complete cursor', () => {
    expect(safePageCursor(AT, ID)).toEqual({ identifier: ID, timestamp: AT });
  });

  it('drops a partial cursor rather than paging with half a comparison', () => {
    // Half a cursor is not a smaller page: it changes what the comparison means.
    expect(safePageCursor(AT, null)).toBeNull();
    expect(safePageCursor(null, ID)).toBeNull();
    expect(safePageCursor(null, null)).toBeNull();
  });

  it('drops a malformed cursor', () => {
    expect(safePageCursor('yesterday', ID)).toBeNull();
    expect(safePageCursor(AT, 'not-a-uuid')).toBeNull();
    expect(safeTimestamp('x'.repeat(80))).toBeNull();
  });

  it('applies the same rule to the timeline triple', () => {
    expect(safeTimelineCursor(AT, 'conversation', ID)).toEqual({
      eventAt: AT,
      eventId: ID,
      eventKind: 'conversation',
    });
    expect(safeTimelineCursor(AT, null, ID)).toBeNull();
    expect(safeTimelineCursor(AT, 'invented', ID)).toBeNull();
    expect(safeTimelineCursor(null, 'conversation', ID)).toBeNull();
  });
});

describe('search terms', () => {
  it('accepts a term the database will accept', () => {
    expect(safeSearchTerm('  Robin  ')).toBe('Robin');
    expect(safeSearchTerm('+15551234567')).toBe('+15551234567');
  });

  it('drops a term outside the bounds rather than letting the database raise', () => {
    expect(safeSearchTerm('a')).toBeNull();
    expect(safeSearchTerm('x'.repeat(200))).toBeNull();
    expect(safeSearchTerm('   ')).toBeNull();
    expect(safeSearchTerm(42)).toBeNull();
    expect(safeSearchTerm(null)).toBeNull();
  });
});
