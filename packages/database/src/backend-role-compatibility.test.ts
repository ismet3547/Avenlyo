import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../../supabase/migrations/20260910010000_phase_26_backend_role_compatibility.sql',
    import.meta.url,
  ),
  'utf8',
).replaceAll('\r\n', '\n');
const securityTest = readFileSync(
  new URL('../../../supabase/tests/database/backend_role_compatibility.test.sql', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');

describe('Phase 26 hosted backend role compatibility', () => {
  it('uses auth.role for the voice backend guard instead of the legacy scalar claim', () => {
    expect(migration).toContain("if auth.role() <> 'service_role'");
    expect(migration).not.toContain("current_setting('request.jwt.claim.role'");
  });

  it('keeps the operator business context behind a service-role-only SECURITY DEFINER RPC', () => {
    expect(migration).toContain('create function public.get_agent_location_business_context');
    expect(migration).toContain('perform public.require_platform_service_role()');
    expect(migration).toContain(
      'revoke all on function public.get_agent_location_business_context(uuid)',
    );
    expect(migration).toContain(
      'grant execute on function public.get_agent_location_business_context(uuid)',
    );
    expect(securityTest).toContain(
      'browser roles cannot execute the operator business-context RPC',
    );
  });

  it('advances the additive schema contract to 25', () => {
    expect(migration).toContain('set schema_version = 25');
  });
});
