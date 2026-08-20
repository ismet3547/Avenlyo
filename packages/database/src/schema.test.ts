import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/** Normalizes line endings so migration assertions never depend on the checkout's git config. */
function readSql(url: URL): string {
  return readFileSync(url, 'utf8').split('\r\n').join('\n');
}

const migration = readSql(
  new URL('../../../supabase/migrations/20260816000000_initial_foundation.sql', import.meta.url),
);

const onboardingMigration = readSql(
  new URL('../../../supabase/migrations/20260816010000_phase_1_onboarding.sql', import.meta.url),
);

const onboardingSecurityTest = readSql(
  new URL('../../../supabase/tests/database/onboarding_security.test.sql', import.meta.url),
);

const leadsMigration = readSql(
  new URL('../../../supabase/migrations/20260822000000_phase_10_leads.sql', import.meta.url),
);
const leadIntegrityMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260823000000_phase_10_lead_integrity.sql',
    import.meta.url,
  ),
);
const leadsSecurityTest = readSql(
  new URL('../../../supabase/tests/database/leads_security.test.sql', import.meta.url),
);

const knowledgeMigration = readSql(
  new URL('../../../supabase/migrations/20260816020000_phase_2_knowledge.sql', import.meta.url),
);

const knowledgeHardeningMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260816030000_phase_2_knowledge_hardening.sql',
    import.meta.url,
  ),
);

const knowledgeSecurityTest = readSql(
  new URL('../../../supabase/tests/database/knowledge_security.test.sql', import.meta.url),
);

const agentRuntimeMigration = readSql(
  new URL('../../../supabase/migrations/20260816040000_phase_3_agent_runtime.sql', import.meta.url),
);

const agentRuntimeSecurityTest = readSql(
  new URL('../../../supabase/tests/database/agent_runtime_security.test.sql', import.meta.url),
);
const agentRuntimeReliabilityMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260816050000_phase_3_runtime_reliability.sql',
    import.meta.url,
  ),
);
const voiceMigration = readSql(
  new URL('../../../supabase/migrations/20260816060000_phase_4_inbound_voice.sql', import.meta.url),
);
const voiceReliabilityMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260816061000_phase_4_voice_reliability.sql',
    import.meta.url,
  ),
);
const voiceSecurityTest = readSql(
  new URL('../../../supabase/tests/database/voice_security.test.sql', import.meta.url),
);
const schedulingMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260816070000_phase_5_ezyvet_booking.sql',
    import.meta.url,
  ),
);
const schedulingSecurityTest = readSql(
  new URL('../../../supabase/tests/database/scheduling_security.test.sql', import.meta.url),
);
const schedulingHardeningMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260816071000_phase_5_booking_hardening.sql',
    import.meta.url,
  ),
);
const googleCalendarMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260816080000_phase_6_google_calendar.sql',
    import.meta.url,
  ),
);
const googleCalendarSecurityTest = readSql(
  new URL('../../../supabase/tests/database/google_calendar_security.test.sql', import.meta.url),
);
const schedulingReliabilityMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260816081000_phase_6_scheduling_reliability.sql',
    import.meta.url,
  ),
);
const ezyVetRecoveryMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260816082000_phase_6_ezyvet_recovery_symmetry.sql',
    import.meta.url,
  ),
);
const schedulingReliabilitySecurityTest = readSql(
  new URL('../../../supabase/tests/database/scheduling_reliability.test.sql', import.meta.url),
);
const appointmentReminderMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260818000000_phase_8_appointment_reminders.sql',
    import.meta.url,
  ),
);
const appointmentReminderSecurityTest = readSql(
  new URL(
    '../../../supabase/tests/database/appointment_reminders_security.test.sql',
    import.meta.url,
  ),
);
const appointmentReminderReliabilityMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260818100000_phase_8_reminder_reliability_hardening.sql',
    import.meta.url,
  ),
);
const appointmentReminderReliabilityTest = readSql(
  new URL(
    '../../../supabase/tests/database/appointment_reminder_reliability.test.sql',
    import.meta.url,
  ),
);
const appointmentReminderDeliveryConsistencyMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260818110000_phase_8_reminder_delivery_consistency.sql',
    import.meta.url,
  ),
);
const appointmentReminderDeliveryConsistencyTest = readSql(
  new URL(
    '../../../supabase/tests/database/appointment_reminder_delivery_consistency.test.sql',
    import.meta.url,
  ),
);
const handoffOperationsMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260826000000_phase_13_handoff_operations.sql',
    import.meta.url,
  ),
);
const handoffOperationsSecurityTest = readSql(
  new URL('../../../supabase/tests/database/handoff_operations_security.test.sql', import.meta.url),
);
const handoffOwnershipHardeningMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260826010000_phase_13_ownership_hardening.sql',
    import.meta.url,
  ),
);
const handoffOwnershipHardeningTest = readSql(
  new URL('../../../supabase/tests/database/handoff_ownership_hardening.test.sql', import.meta.url),
);
const handoffWaitingEpisodeMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260826020000_phase_13_waiting_episode_consistency.sql',
    import.meta.url,
  ),
);
const handoffWaitingEpisodeTest = readSql(
  new URL('../../../supabase/tests/database/handoff_waiting_episode.test.sql', import.meta.url),
);
const platformOperationsMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260827000000_phase_14_platform_operations.sql',
    import.meta.url,
  ),
);
const platformOperationsTest = readSql(
  new URL(
    '../../../supabase/tests/database/platform_operations_security.test.sql',
    import.meta.url,
  ),
);
const runtimeHardeningMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260827010000_phase_14_runtime_hardening.sql',
    import.meta.url,
  ),
);
const teamAccessMigration = readSql(
  new URL('../../../supabase/migrations/20260828000000_phase_15_team_access.sql', import.meta.url),
);
const teamAccessTest = readSql(
  new URL('../../../supabase/tests/database/team_access_security.test.sql', import.meta.url),
);
const invitationIdentityMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260828010000_phase_15_invitation_identity_hardening.sql',
    import.meta.url,
  ),
);
const invitationIdentityTest = readSql(
  new URL(
    '../../../supabase/tests/database/invitation_identity_security.test.sql',
    import.meta.url,
  ),
);
const billingEnforcementMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260830000000_phase_17_billing_enforcement.sql',
    import.meta.url,
  ),
);
const billingEnforcementTest = readSql(
  new URL('../../../supabase/tests/database/billing_enforcement.test.sql', import.meta.url),
);

const customerHistoryMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260829000000_phase_16_customer_history.sql',
    import.meta.url,
  ),
);
const customerHistoryTest = readSql(
  new URL('../../../supabase/tests/database/customer_history_security.test.sql', import.meta.url),
);
const customerHistoryHardeningMigration = readSql(
  new URL(
    '../../../supabase/migrations/20260829010000_phase_16_customer_history_hardening.sql',
    import.meta.url,
  ),
);
const customerHistoryHardeningTest = readSql(
  new URL('../../../supabase/tests/database/customer_history_hardening.test.sql', import.meta.url),
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

describe('inbound voice migration definition', () => {
  it('makes DID routing globally unique and provider operations service-role only', () => {
    expect(voiceMigration).toContain('phone_numbers_provider_e164_key');
    expect(voiceMigration).toContain('create function public.require_voice_service_role()');
    expect(voiceMigration).toContain(
      'grant execute on function public.bootstrap_inbound_voice_call',
    );
    expect(voiceMigration).toContain('to service_role');
    expect(voiceMigration).toContain('revoke insert, update, delete on public.phone_numbers');
  });

  it('models explicit voice configuration, call idempotency, and final transcripts', () => {
    expect(voiceMigration).toContain('create table public.voice_configurations');
    expect(voiceMigration).toContain('create table public.voice_webhook_events');
    expect(voiceMigration).toContain('calls_provider_external_call_id_key');
    expect(voiceMigration).toContain('record_inbound_voice_transcript');
    expect(voiceMigration).toContain(
      "'voice:' || target_call_id || ':' || target_external_item_id",
    );
  });

  it('has executable pgTAP coverage for caller isolation and backend-only functions', () => {
    expect(voiceSecurityTest).toContain('global Twilio DID cannot be assigned');
    expect(voiceSecurityTest).toContain(
      'location-scoped member reads only their location voice call',
    );
    expect(voiceSecurityTest).toContain(
      'authenticated clients cannot execute the inbound bootstrap RPC',
    );
    expect(voiceSecurityTest).toContain('transcript external identity is idempotent');
  });

  it('fails safely on replayed provider calls and converges handoffs per live call', () => {
    expect(voiceReliabilityMigration).toContain('where event_type = target_event_type');
    expect(voiceReliabilityMigration).toContain('on conflict do nothing');
    expect(voiceReliabilityMigration).toContain("'voice-handoff:' || target_call.id::text");
    expect(voiceReliabilityMigration).toContain("and mode = 'customer'");
  });
});

describe('veterinary scheduling migration definition', () => {
  it('keeps ezyVet credentials in Vault and removes direct client mutation paths', () => {
    expect(schedulingMigration).toContain('create extension if not exists supabase_vault');
    expect(schedulingMigration).toContain('create table public.integration_credentials');
    expect(schedulingMigration).toContain('vault_secret_id uuid not null');
    expect(schedulingMigration).toContain('integrations_ezyvet_secretless_configuration_check');
    expect(schedulingMigration).toContain('drop policy if exists integrations_update_admin');
    expect(schedulingMigration).toContain('drop policy if exists appointments_insert_member');
  });

  it('uses service-role-only catalog and booking transitions with tenant composite keys', () => {
    expect(schedulingMigration).toContain('create function public.require_ezyvet_service_role()');
    expect(schedulingMigration).toContain('scheduling_appointment_types_integration_scope_fk');
    expect(schedulingMigration).toContain('booking_candidates_resource_scope_fk');
    expect(schedulingMigration).toContain('booking_intents_candidate_scope_fk');
    expect(schedulingMigration).toContain('pg_advisory_xact_lock');
    expect(schedulingMigration).toContain('appointments_provider_external_identity_key');
    expect(schedulingMigration).toContain('candidate.expires_at <= now()');
  });

  it('includes executable pgTAP assertions for catalog isolation and backend-only writes', () => {
    expect(schedulingSecurityTest).toContain(
      'inserted candidate cannot reference an ezyVet resource owned by another organization',
    );
    expect(schedulingSecurityTest).toContain(
      'location-scoped member reads catalog only for their assigned location',
    );
    expect(schedulingSecurityTest).toContain('member cannot directly change catalog bookability');
    expect(schedulingSecurityTest).toContain(
      'authenticated member cannot execute trusted credential RPC',
    );
    expect(schedulingSecurityTest).toContain(
      'owner can set the explicit ezyVet booking policy through its audited RPC',
    );
  });

  it('separates provider success from local persistence and rotates Vault secrets in place', () => {
    expect(schedulingHardeningMigration).toContain('provider_success_pending_persistence');
    expect(schedulingHardeningMigration).toContain('record_voice_booking_provider_success');
    expect(schedulingHardeningMigration).toContain('vault.update_secret');
    expect(schedulingHardeningMigration).toContain('credential_version = previous_version + 1');
    expect(schedulingHardeningMigration).toContain(
      "intent.status = 'provider_success_pending_persistence'",
    );
    expect(schedulingSecurityTest).toContain(
      'provider success has a recoverable, non-repostable persistence state',
    );
    expect(schedulingSecurityTest).toContain('authenticated users cannot reopen a completed');
  });
});

describe('Google Calendar scheduling migration definition', () => {
  it('keeps one trusted active provider and provider-neutral booking data', () => {
    expect(googleCalendarMigration).toContain("provider in ('ezyvet', 'google_calendar')");
    expect(googleCalendarMigration).toContain('create table public.location_scheduling_settings');
    expect(googleCalendarMigration).toContain('active_integration_id');
    expect(googleCalendarMigration).toContain('alter column external_contact_uid drop not null');
    expect(googleCalendarMigration).toContain('booking_intents_contact_scope_fk');
  });

  it('makes OAuth state and refresh credentials backend-only', () => {
    expect(googleCalendarMigration).toContain('create table public.oauth_connection_states');
    expect(googleCalendarMigration).toContain('expires_at > created_at');
    expect(googleCalendarMigration).toContain('consume_google_oauth_state');
    expect(googleCalendarMigration).toContain('vault.update_secret');
    expect(googleCalendarMigration).toContain('get_google_calendar_execution_credentials');
  });

  it('uses mapping-scoped resources and exclusion slot leases', () => {
    expect(googleCalendarMigration).toContain(
      'create table public.scheduling_appointment_type_resources',
    );
    expect(googleCalendarMigration).toContain('scheduling_type_resource_resource_fk');
    expect(googleCalendarMigration).toContain('create table public.booking_slot_leases');
    expect(googleCalendarMigration).toContain('booking_slot_leases_no_overlap');
    expect(googleCalendarMigration).toContain("tstzrange(starts_at, ends_at, '[)')");
  });

  it('has executable tenant and backend-only pgTAP coverage', () => {
    expect(googleCalendarSecurityTest).toContain(
      'type-resource mapping rejects a cross-tenant resource',
    );
    expect(googleCalendarSecurityTest).toContain('member cannot read OAuth state');
    expect(googleCalendarSecurityTest).toContain('consumed OAuth state cannot be reused');
    expect(googleCalendarSecurityTest).toContain(
      'overlapping leases for the same resource are rejected',
    );
  });

  it('separates mutable new-write policy from durable provider recovery', () => {
    expect(schedulingReliabilityMigration).toContain('provider_booking_status');
    expect(schedulingReliabilityMigration).toContain(
      "intent.status = 'provider_success_pending_persistence'",
    );
    expect(schedulingReliabilityMigration).toContain(
      'settings.active_integration_id = intent.integration_id',
    );
    expect(schedulingReliabilityMigration).toContain(
      "intent.status = 'booking' and integration.status = 'connected'",
    );
    expect(schedulingReliabilityMigration).toContain(
      'drop function public.complete_voice_booking_intent(uuid, text, text)',
    );
    expect(schedulingReliabilitySecurityTest).toContain(
      'provider success persists after Google is disconnected',
    );
    expect(schedulingReliabilitySecurityTest).toContain(
      'removed Google type-resource mapping blocks a first provider write',
    );
    expect(schedulingReliabilitySecurityTest).toContain(
      'disabled ezyVet resource blocks a first provider write',
    );
  });

  it('keeps ezyVet credentials recovery-only after a disconnect', () => {
    expect(ezyVetRecoveryMigration).toContain('perform public.require_ezyvet_service_role()');
    expect(ezyVetRecoveryMigration).toContain("and integration.provider = 'ezyvet'");
    expect(ezyVetRecoveryMigration).not.toContain("integration.status = 'connected'");
    expect(ezyVetRecoveryMigration).toContain('active_integration_id = null');
    expect(schedulingReliabilitySecurityTest).toContain(
      'service role retrieves vaulted ezyVet credentials after disconnect for recovery',
    );
    expect(schedulingReliabilitySecurityTest).toContain(
      'a fresh ezyVet write is blocked after disconnect',
    );
    expect(schedulingReliabilitySecurityTest).toContain(
      'service role receives no direct integration credential table grant',
    );
  });
});

describe('appointment reminder migration definition', () => {
  it('keeps reminder state durable, immutable per appointment type, and off direct client writes', () => {
    expect(appointmentReminderMigration).toContain('create table public.appointment_reminders');
    expect(appointmentReminderMigration).toContain('appointment_reminders_appointment_type_key');
    expect(appointmentReminderMigration).toContain('messages_appointment_reminder_key');
    expect(appointmentReminderMigration).toContain('trusted_sms_recipient_e164');
    expect(appointmentReminderMigration).toContain(
      'revoke all on table public.appointment_reminder_settings, public.appointment_reminders',
    );
  });

  it('uses service-only durable claims and never turns reminder revalidation into a provider write', () => {
    expect(appointmentReminderMigration).toContain('for update skip locked');
    expect(appointmentReminderMigration).toContain("interval '5 minutes'");
    expect(appointmentReminderMigration).toContain('require_messaging_service_role');
    expect(appointmentReminderMigration).toContain('appointment_reminders_refresh_trigger');
    expect(appointmentReminderMigration).not.toContain('createBooking');
  });

  it('has executable pgTAP coverage for quiet hours, tenant scope, claims, and immutable delivery identity', () => {
    expect(appointmentReminderSecurityTest).toContain('overnight quiet hours move');
    expect(appointmentReminderSecurityTest).toContain(
      'location-scoped member cannot read another location reminders',
    );
    expect(appointmentReminderSecurityTest).toContain(
      'authenticated member cannot directly mutate reminder state',
    );
    expect(appointmentReminderSecurityTest).toContain(
      'service worker atomically claims the due 24-hour reminder',
    );
    expect(appointmentReminderSecurityTest).toContain(
      'immutable booking-time recipient after contact phone changes',
    );
  });

  it('hardens rollout, earlier quiet-hour scheduling, delivery truth, and bounded reconciliation', () => {
    expect(appointmentReminderReliabilityMigration).toContain(
      'normalize_completed_booking_appointments_internal',
    );
    expect(appointmentReminderReliabilityMigration).toContain(
      'appointments_trusted_sms_recipient_immutable',
    );
    expect(appointmentReminderReliabilityMigration).toContain('delivery_pending');
    expect(appointmentReminderReliabilityMigration).toContain(
      'sync_appointment_reminder_delivery_status',
    );
    expect(appointmentReminderReliabilityMigration).toContain(
      'reconcile_appointment_reminder_schedules',
    );
    expect(appointmentReminderReliabilityMigration).toContain(
      'for update of appointment skip locked',
    );
    expect(appointmentReminderReliabilityMigration).not.toContain('createBooking');
    expect(appointmentReminderReliabilityTest).toContain('spring-forward adjustment chooses');
    expect(appointmentReminderReliabilityTest).toContain(
      'STOP before submission authorizes zero Twilio sends',
    );
    expect(appointmentReminderReliabilityTest).toContain(
      'bounded reconciliation creates 24-hour and 2-hour reminders exactly once',
    );
  });

  it('projects post-send delivery failures and revalidates reminder policy before SMS submission', () => {
    expect(appointmentReminderDeliveryConsistencyMigration).toContain(
      "reminder.status in ('processing', 'delivery_pending', 'sent')",
    );
    expect(appointmentReminderDeliveryConsistencyMigration).toContain(
      'reminder.schedule_version is distinct from settings.schedule_version',
    );
    expect(appointmentReminderDeliveryConsistencyMigration).toContain(
      'expected_scheduled_for is distinct from reminder.scheduled_for',
    );
    expect(appointmentReminderDeliveryConsistencyMigration).toContain(
      'for update of appointment skip locked',
    );
    expect(appointmentReminderDeliveryConsistencyMigration).not.toContain('createBooking');
    expect(appointmentReminderReliabilityTest).toContain(
      'sent then undelivered delivery projects the reminder to failed',
    );
    expect(appointmentReminderReliabilityTest).toContain(
      'transition graph rejects delivered to undelivered',
    );
    expect(appointmentReminderDeliveryConsistencyTest).toContain(
      'disabling 2-hour reminders after materialization authorizes zero provider sends',
    );
    expect(appointmentReminderDeliveryConsistencyTest).toContain(
      'a no-op reminder settings save does not change the schedule version',
    );
    expect(appointmentReminderDeliveryConsistencyTest).toContain(
      'terminal provider skips do not occupy the first bounded reconciliation batch',
    );
  });
});

describe('lead capture migration definition', () => {
  it('keeps lead mutation behind service-only capture and conversion functions', () => {
    expect(leadsMigration).toContain('create function public.capture_conversation_lead');
    expect(leadsMigration).toContain('create function public.convert_booking_lead');
    expect(leadsMigration).toContain('leads_one_active_conversation_idx');
    expect(leadIntegrityMigration).toContain('leads_conversion_appointment_location_fk');
    expect(leadsMigration).toContain('revoke all on table public.leads');
    expect(leadsMigration).toContain("conversation.ai_mode = 'ai'");
  });

  it('ships executable coverage for idempotency, conflicts, direct-write denial, and location scope', () => {
    expect(leadsSecurityTest).toContain('same inbound tool replay is idempotent');
    expect(leadsSecurityTest).toContain(
      'qualified lead conflict takes precedence over qualified state',
    );
    expect(leadsSecurityTest).toContain('authenticated members cannot directly mutate lead state');
    expect(leadsSecurityTest).toContain(
      'location-scoped member reads only leads at the assigned location',
    );
    expect(leadsSecurityTest).toContain(
      'lead cannot reference a conversion appointment from another organization',
    );
    expect(leadsSecurityTest).toContain(
      'booking conversion replay does not duplicate audit history',
    );
  });

  it('enforces location-aware references, durable urgency, and conversion guards', () => {
    expect(leadIntegrityMigration).toContain('leads_contact_location_fk');
    expect(leadIntegrityMigration).toContain('leads_conversation_location_fk');
    expect(leadIntegrityMigration).toContain('lead_capture_tool_calls_message_location_fk');
    expect(leadIntegrityMigration).toContain("intent.status <> 'completed'");
    expect(leadIntegrityMigration).toContain("appointment.status <> 'confirmed'");
    expect(leadIntegrityMigration).toContain("call.provider = 'openai-realtime-sip'");
    expect(leadsSecurityTest).toContain('anonymous voice caller can capture a lead');
    expect(leadsSecurityTest).toContain('later routine capture cannot downgrade urgency');
  });
});

describe('human handoff operations migration definition', () => {
  it('keeps one active customer handoff per conversation at the database level', () => {
    expect(handoffOperationsMigration).toContain('handoffs_one_active_customer_conversation_key');
    expect(handoffOperationsMigration).toContain(
      "where mode = 'customer' and status in ('open', 'acknowledged')",
    );
    expect(handoffOperationsMigration).toContain('pg_catalog.pg_advisory_xact_lock');
    expect(handoffOperationsMigration).toContain(
      'create function public.persist_active_conversation_handoff',
    );
  });

  it('normalizes historical duplicates without deleting escalation history', () => {
    expect(handoffOperationsMigration).toContain("'superseded_by_migration'");
    expect(handoffOperationsMigration).not.toMatch(/deletes+froms+public.handoffs/i);
    expect(handoffOperationsMigration).toContain('last_escalated_at = now()');
  });

  it('binds a handoff to trusted source state inside its own tenant, location, and conversation', () => {
    expect(handoffOperationsMigration).toContain('handoffs_source_message_fk');
    expect(handoffOperationsMigration).toContain('handoffs_source_call_fk');
    expect(handoffOperationsMigration).toContain('Handoff source message is out of scope');
    expect(handoffOperationsMigration).toContain('Handoff source call is out of scope');
    expect(handoffOperationsMigration).toContain('Handoff source identity is immutable');
  });

  it('moves every handoff and ownership mutation behind narrow security-definer RPCs', () => {
    expect(handoffOperationsMigration).toContain(
      'drop policy handoffs_insert_member on public.handoffs',
    );
    expect(handoffOperationsMigration).toContain(
      'drop policy handoffs_update_member on public.handoffs',
    );
    expect(handoffOperationsMigration).toContain(
      'revoke insert, update, delete on public.handoffs from anon, authenticated, service_role',
    );
    expect(handoffOperationsMigration).toContain('Conversation ownership is not directly writable');
    expect(handoffOperationsMigration).toContain('create function public.claim_my_handoff');
    expect(handoffOperationsMigration).toContain('create function public.release_my_handoff');
    expect(handoffOperationsMigration).toContain('create function public.resolve_my_handoff');
  });

  it('keeps resolving an episode separate from resuming automation', () => {
    expect(handoffOperationsMigration).toContain("'resolve_handoff_first'");
    expect(handoffOperationsMigration).toContain("'conversation.ai_resumed'");
    expect(handoffOperationsMigration).toContain("'conversation.human_takeover'");
    expect(handoffOperationsMigration).not.toContain('resolve_my_handoff_and_resume');
  });

  it('protects urgent work and suppresses automation once a person owns the episode', () => {
    expect(handoffOperationsMigration).toContain('Handoff urgency cannot be downgraded');
    expect(handoffOperationsMigration).toContain(
      'or conversation_row.assigned_user_id is not null into human_owned',
    );
    expect(handoffOperationsMigration).toContain("error_code = 'human_ownership_suppressed'");
  });

  it('logs only bounded operational metadata for handoff transitions', () => {
    expect(handoffOperationsMigration).toContain("'handoff.created'");
    expect(handoffOperationsMigration).toContain("'handoff.escalated'");
    expect(handoffOperationsMigration).toContain("'handoff.claimed'");
    expect(handoffOperationsMigration).toContain("'handoff.released'");
    expect(handoffOperationsMigration).toContain("'handoff.resolved'");
    expect(handoffOperationsMigration).not.toContain("'reason', target_reason");
  });

  it('ships executable coverage for ownership, races, queue order, and grants', () => {
    expect(handoffOperationsSecurityTest).toContain(
      'a customer conversation cannot hold two active handoffs',
    );
    expect(handoffOperationsSecurityTest).toContain(
      'the operator who arrives second is told the work is already claimed',
    );
    expect(handoffOperationsSecurityTest).toContain(
      'a replayed claim never rewrites the first acknowledgement',
    );
    expect(handoffOperationsSecurityTest).toContain(
      'a member of another location cannot claim this location work',
    );
    expect(handoffOperationsSecurityTest).toContain(
      'resolving leaves automation paused; resuming is a separate decision',
    );
    expect(handoffOperationsSecurityTest).toContain(
      'AI cannot resume while an escalation episode is still active',
    );
    expect(handoffOperationsSecurityTest).toContain(
      'a later normal signal cannot silently downgrade urgent work',
    );
    expect(handoffOperationsSecurityTest).toContain(
      'a future escalation after resolution opens a new episode',
    );
    expect(handoffOperationsSecurityTest).toContain(
      'an urgent active episode with a waiting customer is the highest operator priority',
    );
    expect(handoffOperationsSecurityTest).toContain(
      'voice escalations appear in the same operator queue',
    );
    expect(handoffOperationsSecurityTest).toContain(
      'a voice escalation never creates an automatic text message',
    );
    expect(handoffOperationsSecurityTest).toContain(
      'no broad service-role handoff CRUD grant exists',
    );
  });
});

describe('handoff ownership hardening migration definition', () => {
  it('serializes every ownership mutation on one per-conversation advisory lock', () => {
    expect(handoffOwnershipHardeningMigration).toContain(
      'create function public.lock_conversation_ownership',
    );
    expect(handoffOwnershipHardeningMigration).toContain(
      "'conversation-handoff:' || target_conversation_id::text",
    );
    for (const guarded of [
      'public.persist_active_conversation_handoff',
      'public.apply_handoff_claim',
      'public.claim_my_handoff',
      'public.release_my_handoff',
      'public.resolve_my_handoff',
      'public.take_over_my_conversation',
      'public.resume_my_conversation_ai',
      'public.create_my_human_reply',
      'public.persist_ai_message_reply',
      'public.claim_sms_delivery_submission',
    ]) {
      expect(handoffOwnershipHardeningMigration).toContain(`create or replace function ${guarded}`);
    }
  });

  it('revalidates authorization after serialization rather than before it', () => {
    expect(handoffOwnershipHardeningMigration).toContain(
      'perform public.lock_conversation_ownership(locked_conversation_id);\n  perform public.authorize_my_handoff_operation',
    );
    expect(handoffOwnershipHardeningMigration).toContain(
      'handoff_row.conversation_id is distinct from locked_conversation_id',
    );
  });

  it('pauses automation centrally without inventing a staff assignment', () => {
    expect(handoffOwnershipHardeningMigration).toContain(
      'create function public.pause_conversation_automation',
    );
    expect(handoffOwnershipHardeningMigration).toContain(
      "perform public.pause_conversation_automation(conversation_row.id, null, 'handoff')",
    );
    expect(handoffOwnershipHardeningMigration).toContain("'transition', 'ai_to_human'");
    expect(handoffOwnershipHardeningMigration).not.toContain(
      "set ai_mode = 'human', assigned_user_id = target_user_id",
    );
  });

  it('normalizes legacy conversations that still owned an active episode', () => {
    expect(handoffOwnershipHardeningMigration).toContain(
      'update public.conversations conversation',
    );
    expect(handoffOwnershipHardeningMigration).toContain("and conversation.ai_mode <> 'human'");
    expect(handoffOwnershipHardeningMigration).not.toMatch(/delete\s+from\s+public\.handoffs/i);
  });

  it('lets human ownership beat queued automation at the provider boundary', () => {
    expect(handoffOwnershipHardeningMigration).toContain(
      "if message.author_type = 'ai' and (\n    conversation.assigned_user_id is not null",
    );
    expect(handoffOwnershipHardeningMigration).toContain(
      "error_code = 'human_ownership_suppressed'",
    );
    expect(handoffOwnershipHardeningMigration).not.toContain("conversation.ai_mode = 'human' then");
  });

  it('binds an episode to the durable conversation scope even with no source row', () => {
    expect(handoffOwnershipHardeningMigration).toContain(
      'conversation_row.location_id is distinct from target_location_id',
    );
    expect(handoffOwnershipHardeningMigration).toContain(
      'conversation_row.organization_id is distinct from target_organization_id',
    );
  });

  it('shares one ownership predicate between the queue filter and the summary count', () => {
    expect(handoffOwnershipHardeningMigration).toContain(
      'create function public.handoff_queue_row_is_mine',
    );
    expect(handoffOwnershipHardeningMigration).toContain(
      "when 'mine' then public.handoff_queue_row_is_mine(",
    );
    expect(handoffOwnershipHardeningMigration).toContain('where public.handoff_queue_row_is_mine(');
  });

  it('keeps the shared protocol helpers internal to every role', () => {
    expect(handoffOwnershipHardeningMigration).toContain(
      'public.lock_conversation_ownership(uuid),\n  public.pause_conversation_automation(uuid, uuid, text),\n  public.handoff_queue_row_is_mine(uuid, uuid, boolean, uuid)\n  from public, anon, authenticated, service_role',
    );
  });

  it('ships executable coverage for the send races and the lock protocol', () => {
    expect(handoffOwnershipHardeningTest).toContain(
      'a manual takeover with no handoff authorizes zero provider submissions',
    );
    expect(handoffOwnershipHardeningTest).toContain(
      'a resolved episode with a human-owned conversation authorizes zero provider submissions',
    );
    expect(handoffOwnershipHardeningTest).toContain(
      'an unclaimed episode still lets its handoff acknowledgement reach the provider',
    );
    expect(handoffOwnershipHardeningTest).toContain(
      'the send boundary leaves submitted provider truth alone instead of suppressing it',
    );
    expect(handoffOwnershipHardeningTest).toContain(
      'a voice escalation pauses automation through the central creation path',
    );
    expect(handoffOwnershipHardeningTest).toContain(
      'no customer conversation can hold an active episode while automation still owns it',
    );
    expect(handoffOwnershipHardeningTest).toContain(
      'the ai to human transition is audited exactly once for a trusted handoff',
    );
    expect(handoffOwnershipHardeningTest).toContain(
      'coalescing and urgency escalation add no second transition audit',
    );
    expect(handoffOwnershipHardeningTest).toContain(
      'assigned to you counts manual takeovers and resolved-but-owned conversations',
    );
    expect(handoffOwnershipHardeningTest).toContain(
      'a handoff cannot be created against a location the conversation does not belong to',
    );
    expect(handoffOwnershipHardeningTest).toContain(
      'every conversation ownership mutation serializes on the shared advisory lock',
    );
    expect(handoffOwnershipHardeningTest).toContain(
      'the advisory lock is always acquired before the first row lock',
    );
  });
});

describe('handoff waiting episode migration definition', () => {
  it('gives the human-attention episode a durable anchor', () => {
    expect(handoffWaitingEpisodeMigration).toContain(
      'add column human_attention_started_at timestamptz',
    );
    expect(handoffWaitingEpisodeMigration).toContain('conversations_human_attention_state_check');
    expect(handoffWaitingEpisodeMigration).toContain(
      'human_attention_started_at is distinct from old.human_attention_started_at',
    );
  });

  it('bounds waiting to the current episode instead of unbounded history', () => {
    expect(handoffWaitingEpisodeMigration).toContain(
      'create or replace function public.conversation_customer_waiting_since',
    );
    expect(handoffWaitingEpisodeMigration).toContain(
      'conversation.human_attention_started_at is not null',
    );
    expect(handoffWaitingEpisodeMigration).toContain(
      'when boundary.replied_at is null then inbound.created_at >= boundary.anchor',
    );
    expect(handoffWaitingEpisodeMigration).not.toContain("'-infinity'::timestamptz");
  });

  it('anchors each episode on the turn that caused it', () => {
    expect(handoffWaitingEpisodeMigration).toContain(
      'select source_message.created_at from public.messages source_message',
    );
    expect(handoffWaitingEpisodeMigration).toContain(
      'create function public.latest_customer_turn_at',
    );
    expect(handoffWaitingEpisodeMigration).toContain(
      'public.latest_customer_turn_at(conversation_row.organization_id, conversation_row.id)',
    );
  });

  it('keeps one episode across claim, release, resolve, and reply but ends it on resume', () => {
    expect(handoffWaitingEpisodeMigration).toContain(
      'when paused then coalesce(target_attention_anchor, now())',
    );
    expect(handoffWaitingEpisodeMigration).toContain(
      "set ai_mode = 'ai', assigned_user_id = null, human_attention_started_at = null",
    );
  });

  it('backfills legacy episodes deterministically without inventing history', () => {
    expect(handoffWaitingEpisodeMigration).toContain('set human_attention_started_at = coalesce(');
    expect(handoffWaitingEpisodeMigration).toContain(
      "case when handoff.status in ('open', 'acknowledged') then 0 else 1 end asc",
    );
    expect(handoffWaitingEpisodeMigration).not.toMatch(
      /min\(inbound\.created_at\)[\s\S]{0,200}set human_attention_started_at/i,
    );
  });

  it('audits a staff ownership acquisition that no handoff covers', () => {
    expect(handoffWaitingEpisodeMigration).toContain(
      'create function public.acquire_conversation_ownership',
    );
    expect(handoffWaitingEpisodeMigration).toContain("'ai_to_human_owned'");
    expect(handoffWaitingEpisodeMigration).toContain("'unassigned_to_human_owner'");
    expect(handoffWaitingEpisodeMigration).toContain('if not paused and not assigning then');
    expect(handoffWaitingEpisodeMigration).toContain(
      "public.acquire_conversation_ownership(\n    conversation_row.id,\n    auth.uid(),\n    'human_reply',",
    );
  });

  it('keeps claiming an active handoff out of the conversation ownership audit', () => {
    expect(handoffWaitingEpisodeMigration).toContain(
      "perform public.pause_conversation_automation(conversation_row.id, null, 'handoff', attention_anchor);\n  update public.conversations set assigned_user_id = target_user_id",
    );
    expect(handoffWaitingEpisodeMigration).not.toContain(
      "pause_conversation_automation(conversation_row.id, target_user_id, 'staff'",
    );
  });

  it('keeps the episode helpers internal to every role', () => {
    expect(handoffWaitingEpisodeMigration).toContain(
      'public.latest_customer_turn_at(uuid, uuid),\n  public.pause_conversation_automation(uuid, uuid, text, timestamptz),\n  public.acquire_conversation_ownership(uuid, uuid, text, timestamptz)\n  from public, anon, authenticated, service_role',
    );
  });

  it('ships executable coverage for the waiting matrix and the ownership audits', () => {
    for (const expected of [
      'waiting starts at the escalating turn, not at a question answered three weeks ago',
      'an automated acknowledgement does not clear a waiting customer',
      'a human reply clears the waiting customer',
      'a new customer turn after a human reply starts waiting from that turn',
      'resolving preserves the episode anchor',
      'resuming clears the episode anchor along with ownership',
      'turns from the finished episode never become waiting work again',
      'a voice episode with no customer text turns fabricates no waiting timestamp',
      'manual takeover anchors on the latest customer turn, not the oldest',
      'the queue read model reports the same waiting turn as the episode derivation',
      'taking over an automation-owned conversation writes one ownership audit',
      'a replayed takeover by the same owner writes no duplicate audit',
      'acquiring an already-human conversation is audited as an ownership change',
      'a reply that acquires ownership is audited as an ownership change',
      'replying again when already the owner writes no duplicate audit',
      'claiming an active handoff writes no redundant conversation ownership audit',
    ]) {
      expect(handoffWaitingEpisodeTest).toContain(expected);
    }
  });
});

describe('platform operations migration definition', () => {
  it('publishes a schema compatibility contract the application can check', () => {
    expect(platformOperationsMigration).toContain('create table public.platform_schema_contract');
    expect(platformOperationsMigration).toContain(
      'insert into public.platform_schema_contract (id, schema_version) values (true, 14)',
    );
    expect(platformOperationsMigration).toContain(
      'create function public.platform_readiness_probe',
    );
  });

  it('keeps runtime state internal with no tenant reader and no broad write grant', () => {
    expect(platformOperationsMigration).toContain(
      'revoke all on table public.platform_schema_contract, public.runtime_instances,\n  public.runtime_component_heartbeats\n  from public, anon, authenticated, service_role',
    );
    expect(platformOperationsMigration).toContain('enable row level security');
    expect(platformOperationsMigration).not.toMatch(/create policy[\s\S]{0,120}runtime_instances/);
    expect(platformOperationsMigration).toContain(
      'grant execute on function\n  public.platform_readiness_probe(),',
    );
  });

  it('models runtime identity as ephemeral and multi-replica safe', () => {
    expect(platformOperationsMigration).toContain('create table public.runtime_instances');
    expect(platformOperationsMigration).toContain(
      'create table public.runtime_component_heartbeats',
    );
    expect(platformOperationsMigration).toContain(
      'runtime_component_heartbeats_instance_component_key unique (instance_id, component)',
    );
    expect(platformOperationsMigration).toContain(
      'where instance_id = target_instance_id and stopped_at is null',
    );
    // No host, container, or network identity is recorded or trusted.
    expect(platformOperationsMigration).not.toMatch(/hostname|ip_address|container_id/i);
  });

  it('records only bounded operational failure detail', () => {
    expect(platformOperationsMigration).toContain(
      'last_error_code text check (last_error_code is null or char_length(last_error_code) between 1 and 60)',
    );
    expect(platformOperationsMigration).toContain(
      'consecutive_failures integer not null default 0',
    );
    expect(platformOperationsMigration).not.toMatch(
      /^s*(stack_trace|payload|response_body|error_payload)s+(text|jsonb)/im,
    );
  });

  it('bounds runtime history without deleting a stale diagnostic row', () => {
    expect(platformOperationsMigration).toContain('create function public.prune_runtime_instances');
    expect(platformOperationsMigration).toContain(
      "instance.stopped_at is not null and instance.stopped_at < now() - interval '2 days'",
    );
    expect(platformOperationsMigration).toContain(
      "instance.last_heartbeat_at < now() - interval '7 days'",
    );
  });

  it('separates work that is due from work that is merely scheduled', () => {
    expect(platformOperationsMigration).toContain(
      "select 'reminders'::text, 'due'::text, count(*)::bigint, min(reminder.scheduled_for)",
    );
    expect(platformOperationsMigration).toContain("'scheduled_future'::text");
    expect(platformOperationsMigration).toContain('reminder.scheduled_for <= now()');
  });

  it('surfaces ambiguous provider truth without reconciling it', () => {
    expect(platformOperationsMigration).toContain("'provider_state_unknown'");
    expect(platformOperationsMigration).toContain("'billing_events'::text, event.status");
    expect(platformOperationsMigration).toContain("'sms_delivery'::text, delivery.status");
    // The snapshot is read-only: no state machine is advanced by observing it.
    expect(platformOperationsMigration).not.toMatch(
      /update public\.(message_deliveries|stripe_webhook_events|appointment_reminders|booking_intents)/,
    );
  });

  it('returns no tenant, customer, or provider identifier from the snapshot', () => {
    expect(platformOperationsMigration).toContain(
      'returns table (metric_group text, metric text, value bigint, oldest_at timestamptz, detail text)',
    );
    expect(platformOperationsMigration).not.toMatch(
      /stripe_event_id|stripe_customer_id|recipient_e164|contact_id|conversation_id\b.*snapshot/i,
    );
  });

  it('adds only narrow partial indexes for operational aggregation', () => {
    expect(platformOperationsMigration).toContain('create index message_deliveries_unresolved_idx');
    expect(platformOperationsMigration).toContain('create index booking_intents_ambiguous_idx');
    expect(platformOperationsMigration).toContain(
      'create index appointment_change_intents_ambiguous_idx',
    );
    expect(platformOperationsMigration).toMatch(/create index[\s\S]{0,200}where status/);
  });

  it('ships executable coverage for the platform boundary and aggregation', () => {
    for (const expected of [
      'the deployed schema is at least the version Phase 14 requires',
      'the trusted backend has no broad runtime instance write grant',
      'an authenticated caller cannot write runtime state directly',
      'every platform function pins an empty search path',
      'a tick that found no work still counts as success',
      'a successful tick clears the failure streak',
      'the other replica keeps running',
      'a recently silent instance is kept because silence is itself the diagnosis',
      'only a reminder that is actually due counts as due work',
      'a reminder scheduled for the future is reported separately and never as backlog',
      'an ambiguous SMS delivery is visible without being changed',
      'a failed Stripe webhook event is visible',
      'the snapshot exposes no customer or contact value',
      'platform tables carry no tenant, customer, or credential column',
      'reading the snapshot does not resolve an ambiguous delivery',
    ]) {
      expect(platformOperationsTest).toContain(expected);
    }
  });
});

describe('runtime hardening migration definition', () => {
  it('is additive and never rewrites the merged platform operations migration', () => {
    // The Phase 14 migration is already merged; correcting it in place would change a migration a
    // deployed database has already applied.
    expect(runtimeHardeningMigration).not.toContain('drop table');
    expect(runtimeHardeningMigration).not.toContain('drop function');
    expect(runtimeHardeningMigration).not.toMatch(/alter table[\s\S]{0,80}drop column/i);
    expect(platformOperationsMigration).toContain(
      'last_error_code text check (last_error_code is null or char_length(last_error_code) between 1 and 60)',
    );
  });

  it('gives a process its own heartbeat that cannot resurrect a stopped instance', () => {
    expect(runtimeHardeningMigration).toContain(
      'create function public.heartbeat_runtime_instance(target_instance_id uuid)',
    );
    // An update, never an insert or upsert: it cannot create an instance, and the predicate
    // excludes a deliberately stopped one.
    expect(runtimeHardeningMigration).toContain(
      'where instance_id = target_instance_id and stopped_at is null',
    );
    expect(runtimeHardeningMigration).not.toMatch(
      /heartbeat_runtime_instance[\s\S]{0,600}insert into public\.runtime_instances/,
    );
    expect(runtimeHardeningMigration).toContain("set search_path = ''");
    expect(runtimeHardeningMigration).toContain('perform public.require_platform_service_role()');
  });

  it('grants exactly one narrow execution boundary and no table write', () => {
    expect(runtimeHardeningMigration).toContain(
      'revoke all on function\n  public.is_approved_runtime_error_code(text),',
    );
    expect(runtimeHardeningMigration).toContain(
      'grant execute on function\n  public.heartbeat_runtime_instance(uuid),',
    );
    // Constraint and policy helpers are not a callable surface for anyone, service_role included.
    expect(runtimeHardeningMigration).not.toMatch(
      /grant execute on function[\s\S]{0,200}is_approved_runtime_error_code/,
    );
    expect(runtimeHardeningMigration).not.toMatch(
      /grant (insert|update|delete|all)[\s\S]{0,80}on table public\.runtime_/i,
    );
  });

  it('constrains a persisted error code to the approved set rather than to a length', () => {
    // Length is not a safety property: a phone number fits in sixty characters.
    expect(runtimeHardeningMigration).toContain(
      'create function public.is_approved_runtime_error_code(candidate text)',
    );
    expect(runtimeHardeningMigration).toContain(
      'add constraint runtime_component_heartbeats_error_code_approved',
    );
    expect(runtimeHardeningMigration).toContain(
      'check (last_error_code is null or public.is_approved_runtime_error_code(last_error_code))',
    );
    for (const code of [
      'provider_timeout',
      'provider_unavailable',
      'database_unavailable',
      'lease_conflict',
      'invalid_webhook',
      'configuration_invalid',
      'unexpected_error',
    ]) {
      expect(runtimeHardeningMigration).toContain(`'${code}'`);
    }
  });

  it('replaces the snapshot definition that counted a silent instance as active', () => {
    // The merged migration counted every not-stopped row; the follow-up replaces the whole
    // function so the corrected definition is the only one a fresh database ever applies.
    expect(platformOperationsMigration).toContain(
      'count(*) filter (where instance.stopped_at is null)::bigint',
    );
    expect(runtimeHardeningMigration).toContain(
      'create or replace function public.get_platform_operational_snapshot()',
    );
  });

  it('counts a silent instance as stale rather than active', () => {
    expect(runtimeHardeningMigration).toContain("'active_instances'::text");
    expect(runtimeHardeningMigration).toContain("'stale_instances'::text");
    expect(runtimeHardeningMigration).toContain(
      'instance.stopped_at is null and instance.last_heartbeat_at >= now() - stale_after',
    );
    expect(runtimeHardeningMigration).toContain(
      'instance.stopped_at is null and instance.last_heartbeat_at < now() - stale_after',
    );
    // A stale row is reclassified, never deleted: silence is the diagnosis.
    expect(runtimeHardeningMigration).not.toMatch(/delete from public\.runtime_instances/);
  });

  it('derives staleness from the heartbeat interval rather than a customer service level', () => {
    // A technical liveness threshold, not an invented service level: the runtime heartbeat
    // interval (25s) times a fixed multiple (4). apps/api asserts the two definitions agree.
    expect(runtimeHardeningMigration).toContain(
      'create function public.runtime_heartbeat_stale_after()',
    );
    expect(runtimeHardeningMigration).toContain(String.raw`select interval ` + "'100 seconds'");
  });
});

describe('team access migration definition', () => {
  it('is additive and rewrites no merged migration', () => {
    expect(teamAccessMigration).not.toMatch(/drop table/i);
    expect(teamAccessMigration).not.toMatch(/alter table[\s\S]{0,80}drop column/i);
    // Authorization helpers are replaced in place, which is how a merged definition is corrected
    // without editing the migration a deployed database already applied.
    expect(teamAccessMigration).toContain(
      'create or replace function public.is_organization_member',
    );
    expect(teamAccessMigration).toContain(
      'create or replace function public.has_location_write_access',
    );
  });

  it('makes membership revocation soft so historical attribution survives', () => {
    expect(teamAccessMigration).toContain('add column revoked_at timestamptz');
    expect(teamAccessMigration).toContain('add column revoked_by_user_id uuid');
    // action_logs, handoffs, and appointment intents all carry foreign keys to this row.
    expect(teamAccessMigration).not.toMatch(/delete from public\.organization_members/);
    expect(teamAccessMigration).toContain('organization_members_revocation_consistent');
    // Ownership transfer is a separate future workflow, so an owner is never revoked and an
    // organization can never be left without an administrator.
    expect(teamAccessMigration).toContain('organization_members_owner_not_revoked');
  });

  it('applies active-membership semantics to every authorization helper it replaces', () => {
    for (const helper of [
      'is_organization_member',
      'is_organization_admin',
      'is_organization_owner',
      'has_location_access',
      'has_location_write_access',
      'get_my_tenant_context',
      'require_knowledge_manager_organization',
      'get_ezyvet_backend_authorization',
      'get_google_backend_authorization',
      'get_or_resume_staff_appointment_change_intent',
      'set_sms_phone_number_enabled_for_user',
      'get_sms_phone_number_for_user',
      'my_billing_admin_organization',
      'bootstrap_workspace',
      'require_owned_onboarding_organization',
    ]) {
      expect(teamAccessMigration).toContain(`create or replace function public.${helper}`);
    }
    expect(teamAccessMigration).toMatch(/revoked_at is null/);
  });

  it('stores an invitation token only as a hash', () => {
    expect(teamAccessMigration).toContain('token_hash text not null unique');
    expect(teamAccessMigration).toContain("check (token_hash ~ '^[0-9a-f]{64}$')");
    // 32 random bytes generated at the database boundary, never chosen by a browser.
    expect(teamAccessMigration).toContain("encode(extensions.gen_random_bytes(32), 'hex')");
    expect(teamAccessMigration).toContain(
      "encode(extensions.digest(plaintext_token, 'sha256'), 'hex')",
    );
    // No column could hold the plaintext even by accident.
    expect(teamAccessMigration).not.toMatch(/token text not null/);
  });

  it('binds an invitation to one normalized identity with a bounded lifetime', () => {
    expect(teamAccessMigration).toContain('email_normalized = lower(btrim(email_normalized))');
    expect(teamAccessMigration).toContain("select interval '7 days'");
    // At most one live bearer link per organization and email at any moment.
    expect(teamAccessMigration).toContain('organization_invitations_pending_email_key');
    expect(teamAccessMigration).toContain('where accepted_at is null and revoked_at is null');
    expect(teamAccessMigration).toContain("check (role in ('admin', 'member'))");
  });

  it('withdraws direct client mutation of membership tables', () => {
    expect(teamAccessMigration).toContain(
      'revoke insert, update, delete on table public.organization_members from authenticated, anon',
    );
    expect(teamAccessMigration).toContain(
      'revoke insert, update, delete on table public.organization_member_locations from authenticated, anon',
    );
    expect(teamAccessMigration).toContain(
      'drop policy if exists organization_members_insert_admin',
    );
    // No broad service-role grant stands in for the permission matrix.
    expect(teamAccessMigration).not.toMatch(
      /grant (insert|update|delete|all)[\s\S]{0,60}to service_role/,
    );
  });

  it('grants team RPCs to authenticated callers only', () => {
    expect(teamAccessMigration).toContain(
      'grant execute on function\n  public.create_my_organization_invitation(uuid, text, text, uuid[]),',
    );
    expect(teamAccessMigration).toContain('to authenticated;');
    // Acceptance derives identity from auth.uid(), so a backend role must not be able to run it.
    expect(teamAccessMigration).toContain(
      'revoke all on function\n  public.create_my_organization_invitation(uuid, text, text, uuid[]),',
    );
  });

  it('advances the schema compatibility contract to 15', () => {
    expect(teamAccessMigration).toContain('set schema_version = 15');
  });

  it('proves the security properties it claims', () => {
    for (const expected of [
      'a browser client cannot insert a membership row',
      'a revoked member immediately loses organization membership',
      'the plaintext token is never what is stored',
      'no action log contains the plaintext invitation token',
      'no action log contains an invitation email address',
      'acceptance is refused when the authenticated email is not the invited one',
      'reissuing revokes the previous invitation',
      'an admin cannot invite another admin',
      'an owner cannot be revoked, so an organization always keeps an administrator',
      'the membership row survives, so historical attribution keeps its foreign key',
      'revocation does not auto-resolve the handoff',
      'revocation does not resume the AI',
      'an owner can still release work abandoned by a revoked member',
    ]) {
      expect(teamAccessTest).toContain(expected);
    }
  });
});

describe('invitation identity hardening migration definition', () => {
  it('is additive and leaves the reviewed team access migration intact', () => {
    expect(invitationIdentityMigration).not.toMatch(/drop table/i);
    expect(invitationIdentityMigration).not.toMatch(/alter table[\s\S]{0,80}drop column/i);
    // The reviewed migration still contains its own definitions; corrections arrive by replacement.
    expect(teamAccessMigration).toContain(
      'create function public.accept_my_organization_invitation',
    );
    expect(invitationIdentityMigration).toContain(
      'create or replace function public.accept_my_organization_invitation',
    );
  });

  it('requires a confirmed address before an invitation can be accepted', () => {
    // Proving which address an account claims is not proof it owns the mailbox.
    expect(invitationIdentityMigration).toContain('account.email_confirmed_at is not null');
    expect(invitationIdentityMigration).toContain("'verified_email_required'::text");
    expect(invitationIdentityMigration).toContain(
      'create function public.confirmed_account_email(target_user_id uuid)',
    );
  });

  it('resolves member identity from the account rather than the profile mirror', () => {
    expect(invitationIdentityMigration).toContain(
      'create function public.organization_has_active_member_email',
    );
    expect(invitationIdentityMigration).toContain(
      'join auth.users as account on account.id = member.user_id',
    );
    // The mirror is display data; nothing authorizes from it.
    expect(invitationIdentityMigration).not.toMatch(
      /join public\.users as profile[\s\S]{0,200}normalize_team_email\(profile\.email\)/,
    );
  });

  it('never lets acceptance rewrite an active membership', () => {
    expect(invitationIdentityMigration).toContain(
      'if membership_id is not null and not membership_revoked then',
    );
    expect(invitationIdentityMigration).toContain("'already_member'::text");
    // Only a revoked membership may be reactivated.
    expect(invitationIdentityMigration).toContain('member.revoked_at is not null');
  });

  it('keeps the identity helpers off every callable boundary', () => {
    expect(invitationIdentityMigration).toContain(
      'revoke all on function\n  public.confirmed_account_email(uuid),\n  public.organization_has_active_member_email(uuid, text)\n  from public, anon, authenticated, service_role;',
    );
    // No new RPC exposes auth.users, and none is granted to service_role.
    expect(invitationIdentityMigration).not.toMatch(
      /grant execute[\s\S]{0,200}confirmed_account_email/,
    );
    expect(invitationIdentityMigration).not.toMatch(/to service_role/);
    expect(invitationIdentityMigration).not.toMatch(/email_confirmed_at[\s\S]{0,40}returns table/);
  });

  it('proves the identity properties it claims', () => {
    for (const expected of [
      'an unconfirmed account cannot accept an invitation to its own address',
      'the current auth address identifies the active member',
      'the stale mirror address is not treated as a member identity',
      'the active admin was not demoted by presenting a member invitation',
      'the active member keeps the location scope they were actually granted',
      'the owner role survives an invitation that would have set it to admin',
      'the owner cannot demote themself by accepting a member invitation',
      'a revoked member is reactivated by a fresh invitation',
      'reactivation replaces the old scope with exactly the invitation scope',
    ]) {
      expect(invitationIdentityTest).toContain(expected);
    }
  });
});

describe('customer history migration definition', () => {
  it('is additive and creates no competing customer table', () => {
    expect(customerHistoryMigration).not.toMatch(/drop table/i);
    // contacts stays the canonical person record; "Customers" is only what the operator calls it.
    for (const rival of ['customers', 'customer_profiles', 'crm_contacts', 'people']) {
      expect(customerHistoryMigration).not.toContain(`create table public.${rival}`);
    }
  });

  it('derives visibility from location activity rather than the contact row', () => {
    // contacts.location_id records where someone was first seen, not where they have been active.
    expect(customerHistoryMigration).toContain(
      'create function public.contact_has_location_activity',
    );
    expect(customerHistoryMigration).toContain(
      'create function public.contact_visible_at_location',
    );
    expect(customerHistoryMigration).toContain(
      'create function public.my_customer_location_organization',
    );
    // Location access, not an organization identifier the browser supplies.
    expect(customerHistoryMigration).toContain(
      'public.has_location_access(location.organization_id, location.id)',
    );
  });

  it('excludes test-agent activity from every customer surface', () => {
    expect(customerHistoryMigration).toMatch(/conversation\.mode = 'customer'/);
    expect(customerHistoryMigration).toContain(
      "call.conversation_id is null or conversation.mode = 'customer'",
    );
  });

  it('bounds every page in the database rather than trusting the caller', () => {
    expect(customerHistoryMigration).toContain(
      'select least(greatest(coalesce(requested, 25), 1), 50)',
    );
    expect(customerHistoryMigration).toContain('public.customer_history_page_limit(page_limit)');
  });

  it('reads consent from its own record and never mutates anything', () => {
    expect(customerHistoryMigration).toContain('public.messaging_contact_preferences');
    // Consent is a property of the messaging route, so the lookup is scoped to this location
    // rather than showing one location a decision made at another.
    expect(customerHistoryMigration).toContain('preference.location_id = target_location_id');
    // Read-only by construction: no write of any kind, and no action log for viewing history.
    expect(customerHistoryMigration).not.toMatch(/insert into public\.action_logs/);
    expect(customerHistoryMigration).not.toMatch(
      /update public\.(contacts|conversations|messages|calls|appointments|leads|handoffs|message_deliveries)/,
    );
  });

  it('withdraws direct client mutation of contacts', () => {
    // Every other operational table lost its client mutation policies in the phase that grew a real
    // boundary; contacts was simply never revisited.
    expect(customerHistoryMigration).toContain(
      'revoke insert, update, delete on table public.contacts from authenticated, anon',
    );
    expect(customerHistoryMigration).toContain('drop policy if exists contacts_update_member');
    expect(customerHistoryMigration).not.toMatch(/revoke select on table public\.contacts/);
  });

  it('keeps the read models authenticated and the helpers internal', () => {
    expect(customerHistoryMigration).toContain(
      'grant execute on function\n  public.get_my_customer_directory(uuid, text, timestamptz, uuid, integer),',
    );
    expect(customerHistoryMigration).toContain('to authenticated;');
    // Not service-role: these derive the caller from auth.uid(), and a backend role standing in for
    // a person would bypass the location authorization that is the point.
    expect(customerHistoryMigration).not.toMatch(/to service_role/);
    expect(customerHistoryMigration).toContain(
      'revoke all on function\n  public.customer_history_page_limit(integer),',
    );
  });

  it('indexes access paths without indexing customer content', () => {
    expect(customerHistoryMigration).toContain('create index conversations_location_activity_idx');
    expect(customerHistoryMigration).toContain('create index calls_location_contact_idx');
    // Transcript search is not part of this phase, and indexing message bodies to support a feature
    // nobody asked for is how a search index becomes an exfiltration surface.
    expect(customerHistoryMigration).not.toMatch(/using gin/i);
    expect(customerHistoryMigration).not.toMatch(/trigram|gin_trgm/i);
    expect(customerHistoryMigration).not.toMatch(/create index[\s\S]{0,80}\(body\)/i);
    expect(customerHistoryMigration).not.toMatch(/create index[\s\S]{0,80}metadata/i);
  });

  it('advances the schema compatibility contract to 16', () => {
    expect(customerHistoryMigration).toContain('set schema_version = 16');
  });

  it('proves the security properties it claims', () => {
    for (const expected of [
      'Location A counts its own two conversations, not the three across the organization',
      'a customer active only at Location B is absent from Location A',
      'an organization contact with no location activity is not a customer of that location',
      'the test-agent conversation never appears in customer history',
      'no Location B event leaks into the Location A timeline',
      'a web conversation with no contact is labelled rather than given a synthesised customer',
      'an unknown delivery is never relabelled as sent or failed',
      'a revoked member immediately loses the customer directory',
      'an owner asking for Location A receives Location A history only',
      'a browser client cannot rewrite a customer phone number or name',
      'no customer read model exposes provider identifiers, tokens, or raw metadata',
    ]) {
      expect(customerHistoryTest).toContain(expected);
    }
  });
});

describe('customer history hardening migration definition', () => {
  it('is additive and leaves the reviewed history migration intact', () => {
    expect(customerHistoryHardeningMigration).not.toMatch(/drop table/i);
    expect(customerHistoryHardeningMigration).toContain(
      'create or replace function public.get_my_conversation_archive',
    );
    // The reviewed migration still contains its own definitions; corrections arrive by replacement.
    expect(customerHistoryMigration).toContain(
      'create function public.get_my_conversation_archive',
    );
  });

  it('closes the raw contact read path', () => {
    // The Phase 0 policy authorized contacts by contacts.location_id, which is weaker than the
    // Phase 16 rule and also exposed metadata the read models omit.
    expect(customerHistoryHardeningMigration).toContain(
      'revoke select on table public.contacts from authenticated, anon',
    );
    expect(customerHistoryHardeningMigration).toContain(
      'drop policy if exists contacts_select_member on public.contacts',
    );
  });

  it('normalizes the canonical voice channel in one place', () => {
    // Phase 4 stores inbound voice as channel_type 'phone'.
    expect(customerHistoryHardeningMigration).toContain(
      'create function public.history_conversation_channel',
    );
    expect(customerHistoryHardeningMigration).toContain("when 'phone' then 'voice'");
    // And the web default is gone: an unknown channel is not declared to be web chat.
    expect(customerHistoryHardeningMigration).not.toContain(
      "coalesce(channel.channel_type, 'web')",
    );
    expect(customerHistoryHardeningMigration).toContain("else 'unknown'");
  });

  it('scopes every associated conversation record to the selected location', () => {
    expect(customerHistoryHardeningMigration).toContain(
      'and appointment.location_id = target_location_id',
    );
    expect(customerHistoryHardeningMigration).toContain(
      'and call.location_id is not distinct from target_location_id',
    );
    expect(customerHistoryHardeningMigration).toContain(
      'and lead.location_id is not distinct from target_location_id',
    );
    expect(customerHistoryHardeningMigration).toContain(
      'and handoff.location_id is not distinct from target_location_id',
    );
  });

  it('refuses a partial pagination cursor', () => {
    // Half a cursor is not a smaller page: it changes the comparison and can skip or repeat rows.
    expect(customerHistoryHardeningMigration).toContain(
      'create function public.require_complete_history_cursor',
    );
    expect(customerHistoryHardeningMigration).toContain('History cursor is incomplete');
    expect(customerHistoryHardeningMigration).toContain(
      'num_nulls(cursor_event_at, cursor_event_kind, cursor_event_id) not in (0, 3)',
    );
  });

  it('keeps the schema compatibility version at 16', () => {
    // This corrects Phase 16 behaviour inside the same unmerged phase; it adds no capability a
    // Phase 16 build could not already assume.
    expect(customerHistoryHardeningMigration).not.toMatch(/set schema_version = 1[^6]/);
  });

  it('proves the hardening properties it claims', () => {
    for (const expected of [
      'a browser client cannot read the contacts table directly',
      'an activity-less contact whose home location is accessible cannot be fetched directly',
      'contact metadata is not browser-readable',
      'trusted SMS ingestion still creates its contact',
      'trusted voice ingestion still creates its contact',
      'a phone-channel conversation projects as voice, which is the word the product uses',
      'the voice filter finds a real Phase 4 voice conversation',
      'a conversation with no channel row is reported unknown rather than declared web chat',
      'an appointment recorded at another location is not returned with this conversation',
      'a call recorded at another location is not returned with this conversation',
      'a directory cursor missing its identifier is refused',
    ]) {
      expect(customerHistoryHardeningTest).toContain(expected);
    }
  });
});

describe('phase 17 billing enforcement', () => {
  it('advances the schema compatibility contract to 17', () => {
    expect(billingEnforcementMigration).toContain('set schema_version = 17');
  });

  it('derives entitlement from durable projection state and never from a live provider call', () => {
    expect(billingEnforcementMigration).toContain(
      'create function public.billing_feature_available',
    );
    // No freshness clock anywhere in the predicate: a Stripe outage must not be able to turn into
    // a mass customer outage, and a webhook backlog can only delay a transition.
    expect(billingEnforcementMigration).not.toMatch(/last_synced_at\s*[<>]/);
  });

  it('fails closed on ambiguous or unsupported provider topology', () => {
    expect(billingEnforcementMigration).toContain(
      'current_count = 1 and entitled_status_count = 1',
    );
    expect(billingEnforcementMigration).toContain('subscription.is_supported');
    expect(billingEnforcementMigration).toContain("in ('active', 'trialing', 'past_due')");
    // A scheduled cancellation is not a suspension, so the predicate must not read that flag.
    expect(billingEnforcementMigration).not.toMatch(/cancel_at_period_end[^\n]*then/);
  });

  it('keeps every entitlement helper off every callable role', () => {
    for (const helper of [
      'public.billing_feature_available(uuid, text)',
      'public.billing_conversation_feature(uuid)',
      'public.billing_message_job_blocked(uuid)',
      'public.billing_sms_compliance_exempt(uuid)',
    ]) {
      expect(billingEnforcementMigration).toContain(helper);
    }
    // Service identity proves a caller may do backend work, never that a tenant may consume a paid
    // feature, so no grant restores these to service_role either.
    expect(billingEnforcementMigration).not.toMatch(
      /grant execute on function[^;]*billing_feature_available[^;]*service_role/,
    );
  });

  it('gives suppressed work a terminal disposition with a bounded reason', () => {
    expect(billingEnforcementMigration).toContain(
      "check (status in ('queued', 'processing', 'completed', 'failed', 'suppressed'))",
    );
    expect(billingEnforcementMigration).toContain(
      "check (rejection_reason is null or rejection_reason in ('billing_unavailable'))",
    );
    expect(billingEnforcementMigration).toContain("last_error_code = 'billing_unavailable'");
  });

  it('never rewrites a delivery that may already have crossed the provider boundary', () => {
    expect(billingEnforcementMigration).toContain("delivery.status = 'queued'");
    expect(billingEnforcementMigration).toContain("delivery_status is distinct from 'queued'");
  });

  it('derives the compliance exemption and offers no way to declare one', () => {
    expect(billingEnforcementMigration).toContain(
      'create function public.billing_sms_compliance_exempt',
    );
    expect(billingEnforcementMigration).toContain("outbound.author_type = 'system'");
    expect(billingEnforcementMigration).toContain("in ('start', 'help')");
    // A generic flag would be exactly the browser- or model-settable bypass this must not become.
    expect(billingEnforcementMigration).not.toMatch(/billing_exempt\s*(boolean|=|,|\))/);
  });

  it('replaces the obsolete single-admin-organization inference', () => {
    expect(billingEnforcementMigration).toContain(
      'drop function public.my_billing_admin_organization();',
    );
    for (const action of [
      'public.begin_my_billing_checkout(\n  target_organization_id uuid,',
      'public.begin_my_billing_portal(target_organization_id uuid)',
      'public.begin_my_billing_refresh(target_organization_id uuid)',
    ]) {
      expect(billingEnforcementMigration).toContain(action);
    }
    expect(billingEnforcementMigration).toContain(
      'public.require_my_billing_admin(target_organization_id)',
    );
  });

  it('rebases the operational snapshot on the hardened runtime definition', () => {
    // Re-emitting a function to extend it silently reverts every later correction to it. The
    // Phase 14 hardening made instance liveness depend on heartbeat freshness rather than on the
    // absence of stopped_at, and that must survive being extended here.
    expect(billingEnforcementMigration).toContain(
      'public.runtime_heartbeat_stale_after()',
    );
    expect(billingEnforcementMigration).toContain("'stale_instances'::text");
  });

  it('reports billing suppression as a business diagnostic, not a health signal', () => {
    expect(billingEnforcementMigration).toContain("'billing_suppression'::text");
    for (const metric of [
      'message_jobs',
      'sms_deliveries',
      'reminders',
      'lead_followups',
      'voice_rejections',
    ]) {
      expect(billingEnforcementMigration).toContain(`'${metric}'::text`);
    }
  });

  it('proves the enforcement properties it claims', () => {
    for (const expected of [
      'an unknown feature name is never entitled',
      'past_due normalizes to attention and stays entitled',
      'two current subscriptions are ambiguous topology and entitle nothing rather than picking one',
      'an organization with no billing account entitles nothing',
      'service role is not an entitlement bypass',
      'a browser cannot mark itself active',
      'a user who administers a second organization can start its checkout',
      'a customer may keep texting an Avenlyo number while the organization subscription is inactive',
      'the opt-out is durably recorded regardless of billing state',
      'a human reply returns a stable bounded outcome instead of sending',
      'unknown stays unknown: billing cannot erase a submission that may already have happened',
      'an existing authorized session keeps reading its history while billing is unavailable',
      'no suppressed job is ever re-claimed',
      'voice configuration survives a full suspend and resume cycle untouched',
    ]) {
      expect(billingEnforcementTest).toContain(expected);
    }
  });
});
