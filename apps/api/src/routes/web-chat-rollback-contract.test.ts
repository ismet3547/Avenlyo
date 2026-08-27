import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

/**
 * The rollback contract for the web-chat poll RPC, pinned at source level.
 *
 * `apps/api/src/observability/readiness.ts` accepts a schema newer than the running build requires,
 * so a release can be rolled back to the previous image without a down-migration. That promise is
 * only real if the newer schema still answers the older build's calls.
 *
 * Phase 19 changed the poll RPC's signature. The first version of that migration dropped the old
 * two-argument form outright, which would have left a rolled-back Phase 18 binary reporting ready
 * while every web-chat poll failed with "function does not exist" -- readiness green, feature dead.
 *
 * pgTAP proves the overloads behave correctly against a real database. These assertions guard the
 * intent in the repository itself, so a future migration that quietly deletes the compatibility
 * overload, or a future route change that stops sending the argument the current schema needs, fails
 * here rather than during an incident.
 */

const MIGRATION = 'supabase/migrations/20260901000000_phase_19_web_chat_poll_bounds.sql';

async function migration(): Promise<string> {
  return readFile(MIGRATION, 'utf8');
}

describe('the Phase 18 poll call shape survives in the Phase 19 schema', () => {
  it('keeps a two-argument overload with the exact Phase 18 parameter names', async () => {
    // PostgREST calls RPCs by argument name, so the names are part of the wire contract, not an
    // implementation detail. A rolled-back binary sends {target_token_hash, target_after}.
    const sql = await migration();

    expect(sql).toMatch(
      /create function public\.get_web_chat_messages\(\s*target_token_hash text,\s*target_after timestamptz default null\s*\)/,
    );
  });

  it('makes that overload a delegate rather than a second implementation', async () => {
    const sql = await migration();
    const compatibility = sql.slice(
      sql.lastIndexOf('create function public.get_web_chat_messages('),
    );

    // It must call the authoritative function, and must not carry the polling behaviour itself.
    // A narrow existence lookup against web_chat_sessions is expected and asserted below -- what is
    // forbidden is duplicating the message query or the session touch.
    expect(compatibility).toContain('return query select * from public.get_web_chat_messages(');
    expect(compatibility).not.toContain('update public.web_chat_sessions');
    expect(compatibility).not.toContain('from public.messages');
    expect(compatibility).not.toContain('limit 100');
  });

  it('gates on a live session before it derives a limiter scope', async () => {
    const sql = await migration();
    const compatibility = sql.slice(
      sql.lastIndexOf('create function public.get_web_chat_messages('),
    );

    // The authoritative path deliberately charges the quota before its session lookup, because its
    // scope comes from the canonical client address and has bounded cardinality. This path cannot:
    // a rolled-back binary supplies no address, so the scope is derived from a caller-supplied
    // token. Proving the session first keeps an unknown token from reaching the limiter at all.
    const gate = compatibility.indexOf('from public.web_chat_sessions');
    const delegate = compatibility.indexOf(
      'return query select * from public.get_web_chat_messages(',
    );

    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(delegate);
    expect(compatibility).toContain("errcode = '42501'");
    expect(compatibility).toContain('public.require_messaging_service_role()');
  });

  it('keeps both overloads service-role only', async () => {
    const sql = await migration();

    for (const signature of ['(text, text, timestamptz)', '(text, timestamptz)']) {
      expect(sql).toContain(
        `revoke all on function public.get_web_chat_messages${signature}\n  from public, anon, authenticated, service_role;`,
      );
      expect(sql).toContain(
        `grant execute on function public.get_web_chat_messages${signature} to service_role;`,
      );
    }
  });

  it('advances the schema contract, because the current build needs the new argument', async () => {
    const sql = await migration();

    expect(sql).toMatch(/update public\.platform_schema_contract\s*\n\s*set schema_version = 19/);
  });

  it('has the running route send the three-argument shape', async () => {
    // The other half of the same contract: this build must actually use the argument whose absence
    // makes an 18 database incompatible, or the version bump would be arbitrary.
    const route = await readFile('apps/api/src/routes/web-chat.ts', 'utf8');
    const call = route.slice(route.indexOf("supabase.rpc('get_web_chat_messages'"));

    expect(call).toContain('target_rate_scope:');
    expect(call).toContain('target_token_hash:');
    expect(call).toContain('target_after:');
  });
});
