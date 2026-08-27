-- Global privilege invariants, asserted after every migration has run.
--
-- supabase/config.toml sets auto_expose_new_tables = true, deliberately, so that local runs
-- carry the hosted platform's posture instead of a friendlier one. The consequence is that
-- every table and function a future migration creates in public is born granted to anon,
-- authenticated and service_role, and PostgreSQL separately grants EXECUTE on a new function
-- to PUBLIC unless told otherwise. Both are silent. A migration author who forgets a revoke
-- publishes a table to the internet and nothing anywhere says so.
--
-- The per-feature suites cannot catch that, because each one only knows about its own objects.
-- This file is deliberately global: it asks what the whole schema exposes and compares it to a
-- written-down allowlist. A new table with no revoke fails here. A new RPC handed to
-- authenticated fails here until someone adds it below and, in doing so, decides to.
--
-- The allowlist is the intentional client surface, and only that. It is not a transcription of
-- whatever privileges happen to exist -- that is the mistake this file exists to prevent, and
-- it is how get_google_backend_authorization(), a service_role backend RPC, briefly acquired
-- explicit anon and authenticated grants: its reachability came from PostgreSQL's PUBLIC
-- default, and effective privilege was mistaken for intended privilege.
--
-- If a test here fails, the question is not "how do I make it pass". It is "did I mean to
-- expose this".

begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(11);

-- ---------------------------------------------------------------------------------------
-- anon reaches nothing at all.
-- ---------------------------------------------------------------------------------------

select extensions.is_empty(
  $q$ select c.relname::text, a.privilege_type::text
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join lateral aclexplode(c.relacl) a on a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
      join pg_roles g on g.oid = a.grantee
      where n.nspname = 'public' and g.rolname = 'anon' $q$,
  'anon holds no direct DML on any table in public'
);

select extensions.is_empty(
  $q$ select p.proname::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE') $q$,
  'anon can execute no function in public'
);

-- ---------------------------------------------------------------------------------------
-- The backend never touches a table directly. Every backend path is a SECURITY DEFINER RPC,
-- so a direct service_role grant means a path was added that skips the RPC's own checks.
-- ---------------------------------------------------------------------------------------

select extensions.is_empty(
  $q$ select c.relname::text, a.privilege_type::text
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join lateral aclexplode(c.relacl) a on a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
      join pg_roles g on g.oid = a.grantee
      where n.nspname = 'public' and g.rolname = 'service_role' $q$,
  'service_role holds no direct DML on any table in public'
);

-- ---------------------------------------------------------------------------------------
-- PUBLIC keeps no EXECUTE. This is the default PostgreSQL applies to every new function, and
-- it is the one that hid a backend RPC in plain sight.
-- ---------------------------------------------------------------------------------------

select extensions.is_empty(
  $q$ select p.proname::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and (p.proacl is null
             or exists (select 1 from aclexplode(p.proacl) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE')) $q$,
  'PUBLIC retains no EXECUTE on any function in public'
);

-- ---------------------------------------------------------------------------------------
-- The dashboard's table surface, exactly. Additions and removals both fail.
-- ---------------------------------------------------------------------------------------

select extensions.set_eq(
  $q$ select c.relname::text, string_agg(distinct a.privilege_type::text, ',' order by a.privilege_type::text)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join lateral aclexplode(c.relacl) a on a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
      join pg_roles g on g.oid = a.grantee
      where n.nspname = 'public' and c.relkind in ('r','v','m','p') and g.rolname = 'authenticated'
      group by c.relname $q$,
  $q$ values
      ('action_logs', 'SELECT'),
      ('agent_rules', 'DELETE,INSERT,SELECT,UPDATE'),
      ('agent_test_runs', 'SELECT'),
      ('ai_agents', 'DELETE,INSERT,SELECT,UPDATE'),
      ('appointment_change_intents', 'SELECT'),
      ('appointment_reminder_settings', 'SELECT'),
      ('appointment_reminders', 'SELECT'),
      ('appointments', 'DELETE,INSERT,SELECT,UPDATE'),
      ('calls', 'DELETE,INSERT,SELECT,UPDATE'),
      ('channels', 'DELETE,INSERT,SELECT,UPDATE'),
      ('conversations', 'DELETE,INSERT,SELECT,UPDATE'),
      ('handoffs', 'SELECT'),
      ('industry_templates', 'DELETE,INSERT,SELECT,UPDATE'),
      ('integrations', 'DELETE,INSERT,SELECT,UPDATE'),
      ('knowledge_documents', 'SELECT'),
      ('knowledge_imports', 'SELECT'),
      ('lead_followup_jobs', 'SELECT'),
      ('lead_followup_settings', 'SELECT'),
      ('leads', 'SELECT'),
      ('location_scheduling_settings', 'SELECT'),
      ('locations', 'DELETE,INSERT,SELECT,UPDATE'),
      ('messages', 'DELETE,INSERT,SELECT,UPDATE'),
      ('organization_member_locations', 'SELECT'),
      ('organization_members', 'SELECT'),
      ('organization_onboarding', 'SELECT'),
      ('organizations', 'DELETE,SELECT,UPDATE'),
      ('phone_numbers', 'SELECT'),
      ('scheduling_appointment_type_resources', 'SELECT'),
      ('scheduling_appointment_types', 'SELECT'),
      ('scheduling_resources', 'SELECT'),
      ('sms_consents', 'SELECT'),
      ('users', 'SELECT,UPDATE'),
      ('voice_configurations', 'SELECT')
  $q$,
  'authenticated table DML matches the intentional client surface'
);

-- ---------------------------------------------------------------------------------------
-- The dashboard's RPC surface, exactly. A new RPC granted to authenticated fails here until
-- it is listed, which is the point: the grant becomes a decision someone wrote down.
-- ---------------------------------------------------------------------------------------

select extensions.set_eq(
  $q$ select (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join lateral aclexplode(p.proacl) a on a.privilege_type = 'EXECUTE'
      join pg_roles g on g.oid = a.grantee
      where n.nspname = 'public' and g.rolname = 'authenticated' $q$,
  $q$ values
      ('accept_my_organization_invitation(target_token text)'),
      ('advance_onboarding_website()'),
      ('archive_knowledge_document(target_document_id uuid)'),
      ('begin_agent_test_turn(target_conversation_id uuid, target_idempotency_key uuid, customer_message text, provider_name text, model_name text)'),
      ('begin_knowledge_publish(target_import_id uuid)'),
      ('begin_my_billing_checkout(target_organization_id uuid, target_plan_key text)'),
      ('begin_my_billing_portal(target_organization_id uuid)'),
      ('begin_my_billing_refresh(target_organization_id uuid)'),
      ('bootstrap_workspace()'),
      ('claim_my_handoff(target_handoff_id uuid)'),
      ('complete_agent_test_turn(target_run_id uuid, assistant_body text, source_references jsonb, tool_executions jsonb, handoff_requested boolean, safe_failure_code text)'),
      ('complete_knowledge_publish(target_import_id uuid, document_versions jsonb, generated_chunks jsonb)'),
      ('complete_onboarding()'),
      ('create_agent_test_conversation(target_location_id uuid)'),
      ('create_knowledge_import(root_url_input text, requested_location_id uuid)'),
      ('create_my_google_appointment_type(target_location_id uuid, target_name text, target_duration_minutes integer)'),
      ('create_my_human_reply(target_conversation_id uuid, target_body text)'),
      ('create_my_organization_invitation(target_organization_id uuid, target_email text, target_role text, target_location_ids uuid[])'),
      ('fail_agent_test_turn(target_run_id uuid, safe_failure_code text)'),
      ('fail_knowledge_import(target_import_id uuid, safe_error_code text, safe_error_message text)'),
      ('get_agent_test_conversation(target_conversation_id uuid)'),
      ('get_agent_test_turn_result(target_run_id uuid)'),
      ('get_knowledge_import_review(target_import_id uuid)'),
      ('get_my_appointment_reminder_settings(target_location_id uuid)'),
      ('get_my_appointment_reminders(target_location_id uuid)'),
      ('get_my_billing_execution_summary(target_organization_id uuid)'),
      ('get_my_billing_overview(target_organization_id uuid)'),
      ('get_my_billing_usage_summary(target_organization_id uuid)'),
      ('get_my_conversation_archive(target_location_id uuid, target_channel text, target_status text, target_search text, cursor_activity_at timestamp with time zone, cursor_conversation_id uuid, page_limit integer)'),
      ('get_my_conversation_detail(target_location_id uuid, target_conversation_id uuid)'),
      ('get_my_conversation_handoff_history(target_conversation_id uuid, target_limit integer)'),
      ('get_my_conversation_transcript(target_location_id uuid, target_conversation_id uuid, cursor_created_at timestamp with time zone, cursor_message_id uuid, page_limit integer)'),
      ('get_my_customer_directory(target_location_id uuid, target_search text, cursor_last_activity_at timestamp with time zone, cursor_contact_id uuid, page_limit integer)'),
      ('get_my_customer_overview(target_location_id uuid, target_contact_id uuid)'),
      ('get_my_customer_timeline(target_location_id uuid, target_contact_id uuid, cursor_event_at timestamp with time zone, cursor_event_kind text, cursor_event_id uuid, page_limit integer)'),
      ('get_my_ezyvet_integration_configuration(target_location_id uuid)'),
      ('get_my_google_scheduling_configuration(target_location_id uuid)'),
      ('get_my_handoff_queue(target_location_id uuid, target_filter text, target_limit integer)'),
      ('get_my_handoff_queue_summary(target_location_id uuid)'),
      ('get_my_inbox_conversations(target_location_id uuid)'),
      ('get_my_inbox_lead_indicators(target_location_id uuid)'),
      ('get_my_inbox_messages(target_conversation_id uuid)'),
      ('get_my_knowledge_overview()'),
      ('get_my_lead_detail(target_lead_id uuid)'),
      ('get_my_lead_followup(target_lead_id uuid)'),
      ('get_my_lead_followup_sender_options(target_location_id uuid)'),
      ('get_my_lead_followup_settings(target_location_id uuid)'),
      ('get_my_leads(target_location_id uuid, target_status text, target_source_channel text, target_urgency text)'),
      ('get_my_organization_team(target_organization_id uuid)'),
      ('get_my_recent_voice_calls(target_location_id uuid)'),
      ('get_my_scheduling_appointments(target_location_id uuid)'),
      ('get_my_tenant_context()'),
      ('get_my_voice_configuration(target_location_id uuid)'),
      ('get_my_web_chat_widget(target_location_id uuid)'),
      ('get_my_workspace_context(target_organization_id uuid, target_location_id uuid)'),
      ('get_my_workspace_contexts()'),
      ('has_location_access(target_organization_id uuid, target_location_id uuid)'),
      ('has_location_write_access(target_organization_id uuid, target_location_id uuid)'),
      ('is_organization_admin(target_organization_id uuid)'),
      ('is_organization_creator(target_organization_id uuid)'),
      ('is_organization_member(target_organization_id uuid)'),
      ('is_organization_owner(target_organization_id uuid)'),
      ('is_valid_business_hours(value jsonb)'),
      ('is_valid_location_address(value jsonb)'),
      ('match_my_knowledge(query_embedding_text text, requested_match_count integer, requested_location_id uuid)'),
      ('organization_has_members(target_organization_id uuid)'),
      ('record_agent_test_knowledge_search(target_conversation_id uuid, tool_call_id text)'),
      ('recover_stale_knowledge_publish(target_import_id uuid)'),
      ('release_knowledge_publish(target_import_id uuid, safe_error_code text, safe_error_message text)'),
      ('release_my_handoff(target_handoff_id uuid)'),
      ('request_agent_test_handoff(target_conversation_id uuid, tool_call_id text, handoff_reason text, handoff_urgency text)'),
      ('resolve_my_handoff(target_handoff_id uuid)'),
      ('resume_my_conversation_ai(target_conversation_id uuid)'),
      ('revoke_my_organization_invitation(target_invitation_id uuid)'),
      ('revoke_my_organization_member(target_membership_id uuid)'),
      ('save_knowledge_import_pages(target_import_id uuid, crawled_pages jsonb, discovered_count integer, skipped_count integer, final_root_url text)'),
      ('save_onboarding_business(business_name text, business_website_url text, normalized_business_phone text)'),
      ('save_onboarding_industry(selected_industry_id text)'),
      ('save_onboarding_location(location_name text, location_timezone text, location_address jsonb, location_business_hours jsonb)'),
      ('set_my_active_scheduling_integration(target_location_id uuid, target_integration_id uuid, target_minimum_lead_minutes integer)'),
      ('start_knowledge_import(target_import_id uuid)'),
      ('take_over_my_conversation(target_conversation_id uuid)'),
      ('update_knowledge_document_draft(target_document_id uuid, draft_title text, draft_content text, is_included boolean)'),
      ('update_my_ezyvet_booking_policy(target_location_id uuid, selected_appointment_type_ids uuid[], selected_resource_ids uuid[])'),
      ('update_my_google_booking_policy(target_location_id uuid, selected_appointment_type_ids uuid[], selected_resource_ids uuid[], mappings jsonb)'),
      ('update_my_organization_member_access(target_membership_id uuid, target_role text, target_location_ids uuid[])'),
      ('upsert_my_appointment_reminder_settings(target_location_id uuid, target_sms_enabled boolean, target_24h_enabled boolean, target_2h_enabled boolean, target_quiet_hours_start time without time zone, target_quiet_hours_end time without time zone)'),
      ('upsert_my_lead_followup_settings(target_location_id uuid, target_enabled boolean, target_delay_minutes integer, target_quiet_hours_start time without time zone, target_quiet_hours_end time without time zone, target_business_hours_only boolean, target_sender_phone_number_id uuid, target_acknowledge_sender boolean)'),
      ('upsert_my_voice_configuration(target_location_id uuid, target_enabled boolean, target_voice text, target_transfer_enabled boolean, target_transfer_target_e164 text)'),
      ('upsert_my_web_chat_widget(target_location_id uuid, target_enabled boolean, target_allowed_origins jsonb, target_welcome_message text)')
  $q$,
  'authenticated RPC execute matches the intentional client surface'
);

-- ---------------------------------------------------------------------------------------
-- Backend-owned tables: no client role reaches them at all, by name.
--
-- The set comparisons above already imply this. It is spelled out anyway because these are the
-- tables whose exposure would matter most -- Vault credential references, booking intents,
-- lease tables, the billing ledger -- and a named failure says which one regressed.
-- ---------------------------------------------------------------------------------------

select extensions.is_empty(
  $q$ select c.relname::text, g.rolname::text, a.privilege_type::text
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join lateral aclexplode(c.relacl) a on a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
      join pg_roles g on g.oid = a.grantee
      where n.nspname = 'public'
        and g.rolname in ('anon','authenticated')
        and c.relname in (
          'appointment_change_candidates',
          'appointment_change_slot_leases',
          'appointment_management_targets',
          'billing_accounts',
          'billing_checkout_sessions',
          'billing_core_features',
          'billing_subscriptions',
          'billing_usage_events',
          'booking_candidates',
          'booking_intents',
          'booking_slot_leases',
          'contacts',
          'integration_credentials',
          'knowledge_chunks',
          'lead_capture_tool_calls',
          'message_deliveries',
          'message_processing_jobs',
          'messaging_contact_preferences',
          'messaging_rate_limits',
          'oauth_connection_states',
          'organization_invitation_locations',
          'organization_invitations',
          'platform_schema_contract',
          'runtime_component_heartbeats',
          'runtime_instances',
          'scheduling_slot_leases',
          'stripe_webhook_events',
          'voice_sms_followup_consent_intents',
          'voice_webhook_events',
          'web_chat_sessions',
          'web_chat_widgets'
        ) $q$,
  'backend-owned tables carry no anon or authenticated DML'
);

-- ---------------------------------------------------------------------------------------
-- get_google_backend_authorization(): the specific regression.
--
-- Phase 6 granted it to service_role, and its body opens with require_scheduling_service_role().
-- It was reachable by every role anyway, because Phase 6's PUBLIC revoke list omitted it. The
-- guard rejected them, which is exactly why nobody noticed. "The body rejects it" is defence in
-- depth; the role boundary is the boundary.
-- ---------------------------------------------------------------------------------------

select extensions.ok(
  not has_function_privilege('anon', 'public.get_google_backend_authorization(uuid,uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.get_google_backend_authorization(uuid,uuid)', 'EXECUTE'),
  'no client role can execute get_google_backend_authorization'
);

select extensions.ok(
  has_function_privilege('service_role', 'public.get_google_backend_authorization(uuid,uuid)', 'EXECUTE'),
  'service_role can execute get_google_backend_authorization'
);

-- ---------------------------------------------------------------------------------------
-- Service-role-only backend RPCs, and internal helpers, by name.
--
-- Each backend RPC has its own internal guard, and each guard would reject a browser. That is
-- not the assertion. The assertion is that a browser cannot call them at all.
--
-- The helpers are callable by nobody. A trigger's function is privilege-checked when the
-- trigger is created, not when it fires, so these need no grant to keep working -- they only
-- ever needed one to be called *directly*.
-- ---------------------------------------------------------------------------------------

select extensions.is_empty(
  $q$ select proc
      from unnest(array[
        'public.bootstrap_inbound_voice_call(text,text,text,text,text,text)',
        'public.match_inbound_voice_knowledge(uuid,uuid,text,integer)',
        'public.get_google_backend_authorization(uuid,uuid)',
        'public.create_web_chat_session(uuid,text,text,text)',
        'public.get_web_chat_messages(text,text,timestamptz)',
        'public.get_web_chat_messages(text,timestamptz)'
      ]) as proc
      where has_function_privilege('anon', proc, 'EXECUTE')
         or has_function_privilege('authenticated', proc, 'EXECUTE') $q$,
  'no client role can execute a service-role-only backend RPC'
);

select extensions.is_empty(
  $q$ select proc
      from unnest(array[
        'public.require_scheduling_service_role()',
        'public.set_updated_at()',
        'public.handle_new_user()',
        'public.can_transition_message_delivery(text,text)',
        'public.normalized_twilio_delivery_status(text)',
        'public.validate_ai_agent_template_scope()'
      ]) as proc
      where has_function_privilege('anon', proc, 'EXECUTE')
         or has_function_privilege('authenticated', proc, 'EXECUTE')
         or has_function_privilege('service_role', proc, 'EXECUTE') $q$,
  'no role can directly execute an internal trigger or helper function'
);

select * from extensions.finish();
rollback;
