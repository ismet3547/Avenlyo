import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../supabase/migrations/20260816000000_initial_foundation.sql', import.meta.url),
  'utf8',
);

describe('foundation migration definition', () => {
  it('does not contain blanket FOR ALL tenant policies', () => {
    expect(migration).not.toMatch(/create policy[\s\S]*?for all/i);
    expect(migration).not.toContain('tenant_member_access');
  });

  it('defines role and location-aware authorization helpers', () => {
    expect(migration).toContain('public.is_organization_member');
    expect(migration).toContain('public.is_organization_admin');
    expect(migration).toContain('public.is_organization_owner');
    expect(migration).toContain('public.has_location_access');
    expect(migration).toContain('public.has_location_write_access');
    expect(migration).toContain('public.organization_member_locations');
  });

  it('defines separate administrative and operational policy groups', () => {
    expect(migration).toContain("table_name || '_insert_admin'");
    expect(migration).toContain("table_name || '_insert_member'");
    expect(migration).toContain("table_name || '_delete_admin'");
    expect(migration).toContain('action_logs_select_member');
  });

  it('declares representative composite tenant foreign keys', () => {
    const requiredConstraints = [
      'organization_member_locations_location_fk',
      'ai_agents_location_fk',
      'agent_rules_agent_fk',
      'phone_numbers_location_fk',
      'conversations_contact_fk',
      'messages_conversation_fk',
      'calls_phone_number_fk',
      'appointments_conversation_fk',
      'leads_contact_fk',
      'knowledge_chunks_document_fk',
      'handoffs_conversation_fk',
    ];

    requiredConstraints.forEach((constraint) => {
      expect(migration).toContain(`constraint ${constraint}`);
    });
  });

  it('prevents ambiguous global templates and validates agent template scope', () => {
    expect(migration).toContain('industry_templates_scope_check');
    expect(migration).toContain('(not is_system and organization_id is not null)');
    expect(migration).toContain('validate_ai_agent_template_scope');
  });
});
