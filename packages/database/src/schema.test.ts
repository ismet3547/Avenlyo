import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../supabase/migrations/20260816000000_initial_foundation.sql', import.meta.url),
  'utf8',
);

const onboardingMigration = readFileSync(
  new URL('../../../supabase/migrations/20260816010000_phase_1_onboarding.sql', import.meta.url),
  'utf8',
);

const onboardingSecurityTest = readFileSync(
  new URL('../../../supabase/tests/database/onboarding_security.test.sql', import.meta.url),
  'utf8',
);

const knowledgeMigration = readFileSync(
  new URL('../../../supabase/migrations/20260816020000_phase_2_knowledge.sql', import.meta.url),
  'utf8',
);

const knowledgeHardeningMigration = readFileSync(
  new URL(
    '../../../supabase/migrations/20260816030000_phase_2_knowledge_hardening.sql',
    import.meta.url,
  ),
  'utf8',
);

const knowledgeSecurityTest = readFileSync(
  new URL('../../../supabase/tests/database/knowledge_security.test.sql', import.meta.url),
  'utf8',
);

const agentRuntimeMigration = readFileSync(
  new URL('../../../supabase/migrations/20260816040000_phase_3_agent_runtime.sql', import.meta.url),
  'utf8',
);

const agentRuntimeSecurityTest = readFileSync(
  new URL('../../../supabase/tests/database/agent_runtime_security.test.sql', import.meta.url),
  'utf8',
);
const agentRuntimeReliabilityMigration = readFileSync(
  new URL(
    '../../../supabase/migrations/20260816050000_phase_3_runtime_reliability.sql',
    import.meta.url,
  ),
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

describe('onboarding migration definition', () => {
  it('uses auth-derived atomic workspace bootstrap without caller-supplied tenant identity', () => {
    expect(onboardingMigration).toContain('create function public.bootstrap_workspace()');
    expect(onboardingMigration).toContain('current_user_id uuid := auth.uid()');
    expect(onboardingMigration).not.toMatch(/bootstrap_workspace\([^)]*(user|organization)_id/i);
    expect(onboardingMigration).toContain('drop policy organizations_insert_authenticated');
  });

  it('persists constrained onboarding state and tenant-safe location ownership', () => {
    expect(onboardingMigration).toContain('create table public.organization_onboarding');
    expect(onboardingMigration).toContain('organization_onboarding_location_fk');
    expect(onboardingMigration).toContain("current_step in ('industry', 'business', 'location'");
    expect(onboardingMigration).toContain(
      'grant select on public.organization_onboarding to authenticated',
    );
    expect(onboardingMigration).toContain(
      'revoke insert, update, delete on public.organization_onboarding from authenticated',
    );
    expect(onboardingMigration).not.toContain('organization_onboarding_update_owner');
  });

  it('pairs authenticated table privileges with the existing per-operation RLS policies', () => {
    expect(onboardingMigration).toContain(
      'grant select, insert, update, delete on public.organization_members to authenticated',
    );
    expect(onboardingMigration).toContain('public.contacts,');
    expect(onboardingMigration).toContain('grant select on public.action_logs to authenticated');
    expect(onboardingMigration).not.toContain('grant all');
  });

  it('executes the required onboarding security cases through pgTAP', () => {
    expect(onboardingSecurityTest).toContain('public.bootstrap_workspace()');
    expect(onboardingSecurityTest).toContain("public.save_onboarding_industry('dentistry')");
    expect(onboardingSecurityTest).toContain('a second user cannot directly mutate');
    expect(onboardingSecurityTest).toContain(
      'an organization owner cannot directly complete onboarding',
    );
    expect(onboardingSecurityTest).toContain(
      'onboarding cannot reference a location from another tenant',
    );
    expect(onboardingSecurityTest).toContain(
      'Phase 0 location-scoped RLS still hides unrelated locations',
    );
  });
});

describe('knowledge migration definition', () => {
  it('keeps internal import state and generated chunks off direct authenticated mutation paths', () => {
    expect(knowledgeMigration).toContain('create table public.knowledge_imports');
    expect(knowledgeMigration).toContain(
      'revoke all on public.knowledge_chunks from authenticated',
    );
    expect(knowledgeMigration).toContain(
      'revoke insert, update, delete on public.knowledge_documents from authenticated',
    );
    expect(knowledgeMigration).not.toContain('grant all');
  });

  it('defines tenant-derived publication and retrieval RPCs', () => {
    expect(knowledgeMigration).toContain('create function public.publish_knowledge_import');
    expect(knowledgeMigration).toContain('create function public.match_my_knowledge');
    expect(knowledgeMigration).toContain('public.is_organization_admin');
    expect(knowledgeMigration).toContain("knowledge_document.status = 'ready'");
    expect(knowledgeMigration).toContain('extensions.vector_dims');
  });

  it('reserves publication, scopes replacement archives, and preserves location isolation', () => {
    expect(knowledgeHardeningMigration).toContain('create function public.begin_knowledge_publish');
    expect(knowledgeHardeningMigration).toContain(
      'create function public.complete_knowledge_publish',
    );
    expect(knowledgeHardeningMigration).toContain(
      'create function public.release_knowledge_publish',
    );
    expect(knowledgeHardeningMigration).toContain("status = 'publishing'");
    expect(knowledgeHardeningMigration).toContain(
      'location_id is not distinct from target_location_id',
    );
    expect(knowledgeHardeningMigration).toContain(
      "chunk.content_hash <> encode(extensions.digest(chunk.content, 'sha256'), 'hex')",
    );
    expect(knowledgeHardeningMigration).toContain(
      'public.has_location_access(knowledge_import.organization_id, knowledge_import.location_id)',
    );
  });

  it('executes tenant and state-machine guarantees through pgTAP', () => {
    expect(knowledgeSecurityTest).toContain('owner cannot forge internal import state directly');
    expect(knowledgeSecurityTest).toContain('normal member cannot start knowledge imports');
    expect(knowledgeSecurityTest).toContain(
      'organization B cannot read organization A import data',
    );
    expect(knowledgeSecurityTest).toContain(
      'retrieval returns ready local chunks but excludes drafts',
    );
    expect(knowledgeSecurityTest).toContain(
      'failed new import does not remove previously published knowledge',
    );
  });
});

describe('agent runtime migration definition', () => {
  it('separates test conversation records and removes direct authenticated mutation paths', () => {
    expect(agentRuntimeMigration).toContain("add column mode text not null default 'customer'");
    expect(agentRuntimeMigration).toContain('create table public.agent_test_runs');
    expect(agentRuntimeMigration).toContain(
      'revoke all on public.agent_test_runs from anon, authenticated',
    );
    expect(agentRuntimeMigration).toContain("and mode = 'customer'");
    expect(agentRuntimeMigration).toContain("conversation.mode = 'customer'");
  });

  it('uses tenant-derived, owner/admin-only test RPCs and idempotent handoffs', () => {
    expect(agentRuntimeMigration).toContain('create function public.require_agent_test_admin');
    expect(agentRuntimeMigration).toContain('public.is_organization_admin');
    expect(agentRuntimeMigration).toContain('create function public.begin_agent_test_turn');
    expect(agentRuntimeMigration).toContain('create function public.complete_agent_test_turn');
    expect(agentRuntimeMigration).toContain('create function public.request_agent_test_handoff');
    expect(agentRuntimeMigration).toContain('pg_advisory_xact_lock');
    expect(agentRuntimeMigration).toContain('on conflict (organization_id, idempotency_key)');
  });

  it('has executable pgTAP coverage for test-mode isolation and safe persistence', () => {
    expect(agentRuntimeSecurityTest).toContain('test-mode messages cannot be directly inserted');
    expect(agentRuntimeSecurityTest).toContain('raw retrieved chunks');
    expect(agentRuntimeSecurityTest).toContain('handoff persistence is idempotent');
    expect(agentRuntimeSecurityTest).toContain(
      'location-scoped member cannot read test conversations',
    );
    expect(agentRuntimeSecurityTest).toContain(
      'organization B cannot read organization A test records',
    );
  });

  it('scopes retries to one conversation and recovers only stale in-flight turns', () => {
    expect(agentRuntimeReliabilityMigration).toContain(
      'unique (organization_id, conversation_id, idempotency_key)',
    );
    expect(agentRuntimeReliabilityMigration).toContain("where status = 'running'");
    expect(agentRuntimeReliabilityMigration).toContain("interval '10 minutes'");
    expect(agentRuntimeReliabilityMigration).toContain(
      'create function public.fail_agent_test_turn',
    );
    expect(agentRuntimeReliabilityMigration).toContain(
      'create function public.get_agent_test_turn_result',
    );
  });
});
