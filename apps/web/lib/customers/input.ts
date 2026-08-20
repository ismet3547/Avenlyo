/**
 * External input for customer history routes.
 *
 * Route segments and query parameters are attacker-supplied. Passing them straight into a UUID or
 * timestamptz RPC argument turns a typo into a PostgREST parse error and a 500, which is both a
 * poor experience and a way to learn that an identifier was malformed rather than merely not yours.
 * Everything here fails into the same "unavailable" shape instead.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function safeUuid(value: string | null | undefined): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value : null;
}

/** ISO-8601 that Date can actually parse. A cursor is machine-written, so this is strict. */
export function safeTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * Keyset cursors are all-or-nothing.
 *
 * Half a cursor is not a smaller page: it changes the comparison and can skip or repeat rows. A
 * partial or malformed cursor is dropped, which restarts paging from the newest page — visibly
 * harmless, and never a database error.
 */
export function safePageCursor(
  timestamp: string | null | undefined,
  identifier: string | null | undefined,
): { readonly identifier: string; readonly timestamp: string } | null {
  const safeAt = safeTimestamp(timestamp);
  const safeId = safeUuid(identifier);
  return safeAt && safeId ? { identifier: safeId, timestamp: safeAt } : null;
}

const TIMELINE_EVENT_KINDS = ['appointment', 'call', 'conversation', 'handoff', 'lead'] as const;

export type TimelineEventKind = (typeof TIMELINE_EVENT_KINDS)[number];

/** The timeline cursor is a triple, and the same all-or-nothing rule applies to it. */
export function safeTimelineCursor(
  timestamp: string | null | undefined,
  kind: string | null | undefined,
  identifier: string | null | undefined,
): {
  readonly eventAt: string;
  readonly eventId: string;
  readonly eventKind: TimelineEventKind;
} | null {
  const safeAt = safeTimestamp(timestamp);
  const safeId = safeUuid(identifier);
  const safeKind = TIMELINE_EVENT_KINDS.includes(kind as TimelineEventKind)
    ? (kind as TimelineEventKind)
    : null;
  return safeAt && safeId && safeKind
    ? { eventAt: safeAt, eventId: safeId, eventKind: safeKind }
    : null;
}

/**
 * A customer search term.
 *
 * Bounded to the range the database accepts, so a too-short or oversized term is dropped here
 * rather than becoming an exception. The value itself never travels in a URL.
 */
export function safeSearchTerm(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const term = value.trim();
  return term.length >= 2 && term.length <= 120 ? term : null;
}
