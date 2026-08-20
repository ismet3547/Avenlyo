import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from './errors.js';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from './heartbeat.js';
import { STALE_HEARTBEAT_INTERVAL_MULTIPLE } from './ops-report.js';

/**
 * The same two rules are enforced in TypeScript and in SQL. Two copies of a rule drift, so these
 * assertions fail the build the moment one side is changed without the other.
 */

/** Normalizes line endings so assertions never depend on the checkout's git config. */
const hardeningMigration = readFileSync(
  new URL(
    '../../../../supabase/migrations/20260827010000_phase_14_runtime_hardening.sql',
    import.meta.url,
  ),
  'utf8',
)
  .split('\r\n')
  .join('\n');

describe('runtime staleness threshold', () => {
  it('is a deterministic multiple of the heartbeat interval in both languages', () => {
    const seconds = (DEFAULT_HEARTBEAT_INTERVAL_MS * STALE_HEARTBEAT_INTERVAL_MULTIPLE) / 1000;

    // A technical liveness threshold: several missed heartbeats, not an invented customer promise.
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(25_000);
    expect(STALE_HEARTBEAT_INTERVAL_MULTIPLE).toBe(4);
    expect(seconds).toBe(100);
    expect(hardeningMigration).toContain(`select interval '${seconds} seconds'`);
  });
});

describe('approved operational error codes', () => {
  it('matches the set the database constraint accepts', () => {
    const block = hardeningMigration.slice(
      hardeningMigration.indexOf('create function public.is_approved_runtime_error_code'),
      hardeningMigration.indexOf(
        '$$;',
        hardeningMigration.indexOf('is_approved_runtime_error_code'),
      ),
    );
    const sqlCodes = [...block.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();

    expect(sqlCodes).toEqual([...ERROR_CODES].sort());
  });

  it('separates a provider outage from a database outage', () => {
    // The distinction the classification defect erased. Both must exist for either to be useful.
    expect(ERROR_CODES).toContain('provider_unavailable');
    expect(ERROR_CODES).toContain('database_unavailable');
  });
});
