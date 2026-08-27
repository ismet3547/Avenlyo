-- Make the client-role privilege model explicit instead of inherited.
--
-- Supabase CLI v2.116.0 restored the hosted platform's default for
-- [api].auto_expose_new_tables, which this project leaves unset. That default adds
--
--   alter default privileges in schema public
--     grant all on tables to anon, authenticated, service_role;
--   alter default privileges in schema public
--     grant execute on functions to anon, authenticated, service_role;
--
-- so every table and function a migration creates in public is born with SELECT, INSERT,
-- UPDATE and DELETE -- or EXECUTE -- already granted to the browser roles. Fourteen pgTAP
-- assertions started failing the moment the local CLI matched the hosted platform, which is
-- the point: the assertions were right and the local environment had been flattering us.
--
-- The exposure is not theoretical. Every table below relied on "no grant by default" rather
-- than on a revoke, so on hosted Supabase they are reachable directly through PostgREST by
-- anon and authenticated, with row-level security as the only remaining barrier:
--
--   public.integration_credentials       Vault credential references
--   public.booking_intents               provider booking results
--   public.knowledge_imports             internal import state machine
--   public.knowledge_documents           published knowledge corpus
--   public.scheduling_appointment_types  catalog bookability
--
-- RLS is a second line, not the first one, and several of these tables are backend-owned with
-- no client policy written for them at all. The invariant this project has always asserted is
-- narrower than "RLS will catch it": anon holds no direct table privilege anywhere in public,
-- service_role holds none either because the backend goes through SECURITY DEFINER RPCs, and
-- authenticated holds only the narrow, RLS-gated surface the dashboard actually reads.
--
-- ## Intended surface, not effective surface
--
-- The grants below are the privileges the migration history *decided* to give, read from the
-- explicit grantee entries in each object's ACL. That distinction is the whole correctness
-- argument, and getting it wrong is easy: PostgreSQL grants EXECUTE on a new function to
-- PUBLIC unless told otherwise, so a function nobody ever granted to anyone is still callable
-- by every role. Sixteen functions here are in exactly that state. Reading the *effective*
-- privilege -- has_function_privilege(), which folds PUBLIC in -- would have turned each of
-- those accidents into an explicit anon and authenticated grant, and written a decision nobody
-- made into the schema permanently.
--
-- get_google_backend_authorization() is the clearest case. Phase 6 granted it to service_role
-- and its body opens with require_scheduling_service_role(); it is a backend RPC by
-- construction. It is reachable by anon today only because Phase 6's PUBLIC revoke list
-- omitted it. That is a bug to close, not a surface to preserve, and "the guard inside rejects
-- them anyway" is not the criterion -- the role boundary is. The guard stays as defence in
-- depth behind it.
--
-- So the revokes strip the four DML privileges and EXECUTE from every object in public --
-- PUBLIC included -- and the grants that follow restore exactly the intended surface: 33 table
-- grants, every one to authenticated, and 215 function grants across authenticated and
-- service_role. anon receives nothing at all. TRUNCATE, REFERENCES and TRIGGER are left alone;
-- they were identical under both defaults and are not a client-reachable surface.
--
-- Trigger functions and internal helpers are granted to no role. A trigger's function is
-- privilege-checked when the trigger is created, not when it fires, so set_updated_at() and
-- its neighbours need no grant to keep working -- they only ever needed one to be *callable
-- directly*, which is not something a browser should be able to do.
--
-- Historical migrations are untouched, no policy is relaxed, and no security test is
-- weakened. Objects added after this migration inherit the platform default again, which is
-- why privilege_regression.test.sql now asserts these invariants globally rather than trusting
-- the next author to remember a revoke.

revoke select, insert, update, delete on all tables in schema public
  from public, anon, authenticated, service_role;

-- The dashboard's read and write surface. Every one of these is still behind RLS; the grant
-- only decides whether the role may reach the table at all.
grant select on table public.action_logs to authenticated;
grant delete, insert, select, update on table public.agent_rules to authenticated;
grant select on table public.agent_test_runs to authenticated;
grant delete, insert, select, update on table public.ai_agents to authenticated;
grant select on table public.appointment_change_intents to authenticated;
grant select on table public.appointment_reminder_settings to authenticated;
grant select on table public.appointment_reminders to authenticated;
grant delete, insert, select, update on table public.appointments to authenticated;
grant delete, insert, select, update on table public.calls to authenticated;
grant delete, insert, select, update on table public.channels to authenticated;
grant delete, insert, select, update on table public.conversations to authenticated;
grant select on table public.handoffs to authenticated;
grant delete, insert, select, update on table public.industry_templates to authenticated;
grant delete, insert, select, update on table public.integrations to authenticated;
grant select on table public.knowledge_documents to authenticated;
grant select on table public.knowledge_imports to authenticated;
grant select on table public.lead_followup_jobs to authenticated;
grant select on table public.lead_followup_settings to authenticated;
grant select on table public.leads to authenticated;
grant select on table public.location_scheduling_settings to authenticated;
grant delete, insert, select, update on table public.locations to authenticated;
grant delete, insert, select, update on table public.messages to authenticated;
grant select on table public.organization_member_locations to authenticated;
grant select on table public.organization_members to authenticated;
grant select on table public.organization_onboarding to authenticated;
grant delete, select, update on table public.organizations to authenticated;
grant select on table public.phone_numbers to authenticated;
grant select on table public.scheduling_appointment_type_resources to authenticated;
grant select on table public.scheduling_appointment_types to authenticated;
grant select on table public.scheduling_resources to authenticated;
grant select on table public.sms_consents to authenticated;
grant select, update on table public.users to authenticated;
grant select on table public.voice_configurations to authenticated;

revoke execute on all functions in schema public
  from public, anon, authenticated, service_role;

-- The RPCs each role is intended to call. Backend RPCs are service_role only, and now the
-- guards inside them are no longer the only thing standing between a browser and a backend
-- entry point. Anything absent from this list -- every trigger function, every internal helper
-- -- is callable by no client role at all.
grant execute on function public.accept_my_organization_invitation(target_token text) to authenticated;
grant execute on function public.advance_onboarding_website() to authenticated;
grant execute on function public.append_web_chat_message(target_token_hash text, target_client_message_id uuid, target_body text, target_rate_scope text) to service_role;
grant execute on function public.apply_stripe_billing_snapshot(target_organization_id uuid, target_customer_id text, target_livemode boolean, target_reconciliation_generation bigint, target_subscriptions jsonb, target_snapshot_complete boolean, target_checkout_session_id text, target_checkout_subscription_id text) to service_role;
grant execute on function public.archive_knowledge_document(target_document_id uuid) to authenticated;
grant execute on function public.assert_billing_checkout_eligible(target_checkout_id uuid) to service_role;
grant execute on function public.assign_voice_phone_number(target_organization_id uuid, target_location_id uuid, target_phone_number text, target_label text) to service_role;
grant execute on function public.begin_agent_test_turn(target_conversation_id uuid, target_idempotency_key uuid, customer_message text, provider_name text, model_name text) to authenticated;
grant execute on function public.begin_knowledge_publish(target_import_id uuid) to authenticated;
grant execute on function public.begin_my_billing_checkout(target_organization_id uuid, target_plan_key text) to authenticated;
grant execute on function public.begin_my_billing_portal(target_organization_id uuid) to authenticated;
grant execute on function public.begin_my_billing_refresh(target_organization_id uuid) to authenticated;
grant execute on function public.begin_stripe_billing_reconciliation(target_organization_id uuid, target_customer_id text, target_livemode boolean) to service_role;
grant execute on function public.bootstrap_inbound_sms(target_message_sid text, target_from_e164 text, target_to_e164 text, target_body text, target_media jsonb, target_provider_metadata jsonb) to service_role;
grant execute on function public.bootstrap_inbound_voice_call(target_event_id text, target_event_type text, target_external_call_id text, target_sip_call_id text, target_dialed_e164 text, target_caller_e164 text) to service_role;
grant execute on function public.bootstrap_workspace() to authenticated;
grant execute on function public.capture_conversation_lead(target_inbound_message_id uuid, target_tool_call_id text, target_service_category text, target_urgency text, target_customer_goal text, target_customer_name text, target_details jsonb, target_qualification text, target_voice_call_id text) to service_role;
grant execute on function public.claim_appointment_change_intent(target_conversation_id uuid, target_inbound_message_id uuid, target_change_intent_id uuid, target_tool_call_id text) to service_role;
grant execute on function public.claim_appointment_change_slot_lease(target_change_intent_id uuid) to service_role;
grant execute on function public.claim_booking_slot_lease(target_booking_intent_id uuid) to service_role;
grant execute on function public.claim_conversation_scheduling_booking_intent(target_conversation_id uuid, target_inbound_message_id uuid, target_booking_intent_id uuid, target_tool_call_id text) to service_role;
grant execute on function public.claim_due_appointment_reminders(target_worker_id text, target_limit integer) to service_role;
grant execute on function public.claim_lead_followup_delivery(target_job_id uuid) to service_role;
grant execute on function public.claim_lead_followup_jobs(target_worker_id text, target_limit integer) to service_role;
grant execute on function public.claim_message_processing_jobs(target_worker_id text, target_limit integer) to service_role;
grant execute on function public.claim_my_handoff(target_handoff_id uuid) to authenticated;
grant execute on function public.claim_pending_knowledge_import(target_worker_id text, target_lease_seconds integer) to service_role;
grant execute on function public.claim_sms_delivery_submission(target_message_id uuid) to service_role;
grant execute on function public.claim_stripe_webhook_events(target_worker_id text, target_limit integer) to service_role;
grant execute on function public.claim_voice_booking_intent(target_call_id text, target_booking_intent_id uuid, target_tool_call_id text) to service_role;
grant execute on function public.claim_voice_scheduling_booking_intent(target_call_id text, target_booking_intent_id uuid, target_tool_call_id text) to service_role;
grant execute on function public.claim_voice_scheduling_booking_intent(target_call_id text, target_booking_intent_id uuid, target_tool_call_id text, target_inbound_message_id uuid) to service_role;
grant execute on function public.complete_agent_test_turn(target_run_id uuid, assistant_body text, source_references jsonb, tool_executions jsonb, handoff_requested boolean, safe_failure_code text) to authenticated;
grant execute on function public.complete_appointment_change_intent(target_change_intent_id uuid) to service_role;
grant execute on function public.complete_knowledge_import_crawl(target_import_id uuid, target_claim_token uuid, crawled_pages jsonb, discovered_count integer, skipped_count integer, final_root_url text, target_strategy text) to service_role;
grant execute on function public.complete_knowledge_publish(target_import_id uuid, document_versions jsonb, generated_chunks jsonb) to authenticated;
grant execute on function public.complete_message_processing_job(target_job_id uuid) to service_role;
grant execute on function public.complete_onboarding() to authenticated;
grant execute on function public.complete_scheduling_booking_intent(target_booking_intent_id uuid) to service_role;
grant execute on function public.complete_stripe_webhook_event(target_event_id text, target_status text) to service_role;
grant execute on function public.complete_voice_booking_intent(target_booking_intent_id uuid) to service_role;
grant execute on function public.confirm_voice_sms_followup_consent(target_call_id text, target_consent_intent_id uuid, target_confirmed_message_id uuid) to service_role;
grant execute on function public.consume_google_oauth_state(target_state_hash text) to service_role;
grant execute on function public.create_agent_test_conversation(target_location_id uuid) to authenticated;
grant execute on function public.create_appointment_change_candidates(target_conversation_id uuid, target_inbound_message_id uuid, target_reference_id uuid, target_slots jsonb) to service_role;
grant execute on function public.create_appointment_reminder_message(target_reminder_id uuid) to service_role;
grant execute on function public.create_conversation_appointment_management_targets(target_conversation_id uuid, target_inbound_message_id uuid, target_trusted_caller_e164 text) to service_role;
grant execute on function public.create_conversation_booking_candidates(target_conversation_id uuid, available_slots jsonb) to service_role;
grant execute on function public.create_google_oauth_state(target_user_id uuid, target_location_id uuid, target_state_hash text) to service_role;
grant execute on function public.create_knowledge_import(root_url_input text, requested_location_id uuid) to authenticated;
grant execute on function public.create_lead_followup_message(target_job_id uuid) to service_role;
grant execute on function public.create_my_google_appointment_type(target_location_id uuid, target_name text, target_duration_minutes integer) to authenticated;
grant execute on function public.create_my_human_reply(target_conversation_id uuid, target_body text) to authenticated;
grant execute on function public.create_my_organization_invitation(target_organization_id uuid, target_email text, target_role text, target_location_ids uuid[]) to authenticated;
grant execute on function public.create_staff_appointment_cancellation_intent(target_user_id uuid, target_location_id uuid, target_appointment_id uuid) to service_role;
grant execute on function public.create_staff_appointment_reschedule_intent(target_user_id uuid, target_location_id uuid, target_appointment_id uuid, target_starts_at timestamp with time zone, target_ends_at timestamp with time zone) to service_role;
grant execute on function public.create_voice_booking_candidates(target_call_id text, available_slots jsonb) to service_role;
grant execute on function public.create_web_chat_session(target_widget_public_key uuid, target_origin text, target_token_hash text, target_rate_scope text) to service_role;
grant execute on function public.disable_ezyvet_integration(target_organization_id uuid, target_location_id uuid) to service_role;
grant execute on function public.disable_google_calendar_integration(target_organization_id uuid, target_location_id uuid) to service_role;
grant execute on function public.fail_agent_test_turn(target_run_id uuid, safe_failure_code text) to authenticated;
grant execute on function public.fail_appointment_change_intent(target_change_intent_id uuid, target_status text, target_error_category text) to service_role;
grant execute on function public.fail_knowledge_import(target_import_id uuid, safe_error_code text, safe_error_message text) to authenticated;
grant execute on function public.fail_knowledge_import_as_worker(target_import_id uuid, target_claim_token uuid, safe_error_code text, safe_error_message text, target_failure_kind text) to service_role;
grant execute on function public.fail_scheduling_booking_intent(target_booking_intent_id uuid, target_status text, target_error_category text) to service_role;
grant execute on function public.fail_stripe_webhook_event(target_event_id text, target_error_code text) to service_role;
grant execute on function public.fail_voice_booking_intent(target_booking_intent_id uuid, target_status text, target_error_category text) to service_role;
grant execute on function public.finalize_inbound_voice_call(target_call_id text, target_status text, target_end_reason text) to service_role;
grant execute on function public.get_agent_test_conversation(target_conversation_id uuid) to authenticated;
grant execute on function public.get_agent_test_turn_result(target_run_id uuid) to authenticated;
grant execute on function public.get_appointment_change_execution_context(target_change_intent_id uuid) to service_role;
grant execute on function public.get_appointment_change_execution_context_v2(target_change_intent_id uuid) to service_role;
grant execute on function public.get_appointment_change_target_context(target_conversation_id uuid, target_inbound_message_id uuid, target_reference_id uuid) to service_role;
grant execute on function public.get_appointment_change_target_context_v2(target_conversation_id uuid, target_inbound_message_id uuid, target_reference_id uuid) to service_role;
grant execute on function public.get_appointment_reminder_execution_context(target_reminder_id uuid) to service_role;
grant execute on function public.get_billing_account_execution_context(target_account_id uuid) to service_role;
grant execute on function public.get_billing_checkout_execution_context(target_checkout_id uuid) to service_role;
grant execute on function public.get_billing_customer_execution_context(target_customer_id text, target_livemode boolean) to service_role;
grant execute on function public.get_conversation_scheduling_context(target_conversation_id uuid) to service_role;
grant execute on function public.get_conversation_scheduling_context(target_conversation_id uuid, target_inbound_message_id uuid) to service_role;
grant execute on function public.get_ezyvet_backend_authorization(target_user_id uuid, target_location_id uuid) to service_role;
grant execute on function public.get_ezyvet_bookable_catalog(target_integration_id uuid) to service_role;
grant execute on function public.get_ezyvet_execution_credentials(target_integration_id uuid) to service_role;
grant execute on function public.get_ezyvet_integration_for_location(target_organization_id uuid, target_location_id uuid) to service_role;
grant execute on function public.get_google_backend_authorization(target_user_id uuid, target_location_id uuid) to service_role;
grant execute on function public.get_google_calendar_execution_credentials(target_integration_id uuid) to service_role;
grant execute on function public.get_google_calendar_integration_for_location(target_organization_id uuid, target_location_id uuid) to service_role;
grant execute on function public.get_knowledge_import_review(target_import_id uuid) to authenticated;
grant execute on function public.get_message_agent_context(target_message_id uuid) to service_role;
grant execute on function public.get_message_runtime_context(target_message_id uuid) to service_role;
grant execute on function public.get_my_appointment_reminder_settings(target_location_id uuid) to authenticated;
grant execute on function public.get_my_appointment_reminders(target_location_id uuid) to authenticated;
grant execute on function public.get_my_billing_execution_summary(target_organization_id uuid) to authenticated;
grant execute on function public.get_my_billing_overview(target_organization_id uuid) to authenticated;
grant execute on function public.get_my_billing_usage_summary(target_organization_id uuid) to authenticated;
grant execute on function public.get_my_conversation_archive(target_location_id uuid, target_channel text, target_status text, target_search text, cursor_activity_at timestamp with time zone, cursor_conversation_id uuid, page_limit integer) to authenticated;
grant execute on function public.get_my_conversation_detail(target_location_id uuid, target_conversation_id uuid) to authenticated;
grant execute on function public.get_my_conversation_handoff_history(target_conversation_id uuid, target_limit integer) to authenticated;
grant execute on function public.get_my_conversation_transcript(target_location_id uuid, target_conversation_id uuid, cursor_created_at timestamp with time zone, cursor_message_id uuid, page_limit integer) to authenticated;
grant execute on function public.get_my_customer_directory(target_location_id uuid, target_search text, cursor_last_activity_at timestamp with time zone, cursor_contact_id uuid, page_limit integer) to authenticated;
grant execute on function public.get_my_customer_overview(target_location_id uuid, target_contact_id uuid) to authenticated;
grant execute on function public.get_my_customer_timeline(target_location_id uuid, target_contact_id uuid, cursor_event_at timestamp with time zone, cursor_event_kind text, cursor_event_id uuid, page_limit integer) to authenticated;
grant execute on function public.get_my_ezyvet_integration_configuration(target_location_id uuid) to authenticated;
grant execute on function public.get_my_google_scheduling_configuration(target_location_id uuid) to authenticated;
grant execute on function public.get_my_handoff_queue(target_location_id uuid, target_filter text, target_limit integer) to authenticated;
grant execute on function public.get_my_handoff_queue_summary(target_location_id uuid) to authenticated;
grant execute on function public.get_my_inbox_conversations(target_location_id uuid) to authenticated;
grant execute on function public.get_my_inbox_lead_indicators(target_location_id uuid) to authenticated;
grant execute on function public.get_my_inbox_messages(target_conversation_id uuid) to authenticated;
grant execute on function public.get_my_knowledge_overview() to authenticated;
grant execute on function public.get_my_lead_detail(target_lead_id uuid) to authenticated;
grant execute on function public.get_my_lead_followup(target_lead_id uuid) to authenticated;
grant execute on function public.get_my_lead_followup_sender_options(target_location_id uuid) to authenticated;
grant execute on function public.get_my_lead_followup_settings(target_location_id uuid) to authenticated;
grant execute on function public.get_my_leads(target_location_id uuid, target_status text, target_source_channel text, target_urgency text) to authenticated;
grant execute on function public.get_my_organization_team(target_organization_id uuid) to authenticated;
grant execute on function public.get_my_recent_voice_calls(target_location_id uuid) to authenticated;
grant execute on function public.get_my_scheduling_appointments(target_location_id uuid) to authenticated;
grant execute on function public.get_my_tenant_context() to authenticated;
grant execute on function public.get_my_voice_configuration(target_location_id uuid) to authenticated;
grant execute on function public.get_my_web_chat_widget(target_location_id uuid) to authenticated;
grant execute on function public.get_my_workspace_context(target_organization_id uuid, target_location_id uuid) to authenticated;
grant execute on function public.get_my_workspace_contexts() to authenticated;
grant execute on function public.get_or_resume_staff_appointment_change_intent(target_user_id uuid, target_location_id uuid, target_appointment_id uuid, target_operation text, target_starts_at timestamp with time zone, target_ends_at timestamp with time zone) to service_role;
grant execute on function public.get_platform_operational_snapshot() to service_role;
grant execute on function public.get_platform_runtime_status() to service_role;
grant execute on function public.get_scheduling_bookable_catalog(target_integration_id uuid) to service_role;
grant execute on function public.get_scheduling_booking_execution_context(target_booking_intent_id uuid) to service_role;
grant execute on function public.get_sms_delivery_execution_context(target_message_id uuid) to service_role;
grant execute on function public.get_sms_phone_number_for_user(target_user_id uuid, target_phone_number_id uuid) to service_role;
grant execute on function public.get_voice_appointment_lifecycle_turn(target_call_id text, target_inbound_message_id uuid) to service_role;
grant execute on function public.get_voice_booking_execution_context(target_booking_intent_id uuid) to service_role;
grant execute on function public.get_voice_ezyvet_scheduling_context(target_call_id text) to service_role;
grant execute on function public.get_voice_scheduling_context(target_call_id text) to service_role;
grant execute on function public.get_voice_transcript_message_id(target_call_id text, target_external_item_id text) to service_role;
grant execute on function public.get_web_chat_messages(target_token_hash text, target_after timestamp with time zone) to service_role;
grant execute on function public.has_location_access(target_organization_id uuid, target_location_id uuid) to authenticated;
grant execute on function public.has_location_write_access(target_organization_id uuid, target_location_id uuid) to authenticated;
grant execute on function public.has_persisted_ai_reply(target_inbound_message_id uuid) to service_role;
grant execute on function public.heartbeat_runtime_component(target_instance_id uuid, target_component text, target_state text, target_succeeded boolean, target_error_code text) to service_role;
grant execute on function public.heartbeat_runtime_instance(target_instance_id uuid) to service_role;
grant execute on function public.is_organization_admin(target_organization_id uuid) to authenticated;
grant execute on function public.is_organization_creator(target_organization_id uuid) to authenticated;
grant execute on function public.is_organization_member(target_organization_id uuid) to authenticated;
grant execute on function public.is_organization_owner(target_organization_id uuid) to authenticated;
grant execute on function public.is_valid_business_hours(value jsonb) to authenticated;
grant execute on function public.is_valid_location_address(value jsonb) to authenticated;
grant execute on function public.mark_inbound_voice_call_active(target_call_id text) to service_role;
grant execute on function public.mark_sms_delivery_unknown(target_message_id uuid, target_error_code text) to service_role;
grant execute on function public.match_inbound_voice_knowledge(target_organization_id uuid, target_location_id uuid, query_embedding_text text, requested_match_count integer) to service_role;
grant execute on function public.match_my_knowledge(query_embedding_text text, requested_match_count integer, requested_location_id uuid) to authenticated;
grant execute on function public.organization_has_members(target_organization_id uuid) to authenticated;
grant execute on function public.persist_ai_message_reply(target_inbound_message_id uuid, target_body text, target_handoff_requested boolean) to service_role;
grant execute on function public.persist_appointment_change_mutation_target(target_change_intent_id uuid, target_mutation_target_id text) to service_role;
grant execute on function public.platform_readiness_probe() to service_role;
grant execute on function public.prepare_appointment_change_intent(target_conversation_id uuid, target_inbound_message_id uuid, target_reference_id uuid, target_operation text, target_candidate_id uuid) to service_role;
grant execute on function public.prepare_conversation_scheduling_booking_intent(target_conversation_id uuid, target_candidate_id uuid, resolved_contact_uid text, resolved_subject_uid text, resolved_subject_name text, trusted_contact_id uuid, target_inbound_message_id uuid) to service_role;
grant execute on function public.prepare_voice_booking_intent(target_call_id text, target_candidate_id uuid, resolved_contact_uid text, resolved_subject_uid text, resolved_subject_name text) to service_role;
grant execute on function public.prepare_voice_scheduling_booking_intent(target_call_id text, target_candidate_id uuid, resolved_contact_uid text, resolved_subject_uid text, resolved_subject_name text, trusted_contact_id uuid) to service_role;
grant execute on function public.prepare_voice_sms_followup_consent(target_call_id text, target_prepared_message_id uuid) to service_role;
grant execute on function public.reconcile_appointment_reminder_schedules(target_limit integer) to service_role;
grant execute on function public.record_agent_test_knowledge_search(target_conversation_id uuid, tool_call_id text) to authenticated;
grant execute on function public.record_appointment_change_provider_success(target_change_intent_id uuid, target_provider_state text) to service_role;
grant execute on function public.record_appointment_reminder_revalidation(target_reminder_id uuid, target_outcome text) to service_role;
grant execute on function public.record_billing_portal_opened(target_account_id uuid) to service_role;
grant execute on function public.record_inbound_voice_tool_execution(target_call_id text, target_tool_call_id text, target_tool_name text, target_status text) to service_role;
grant execute on function public.record_inbound_voice_transcript(target_call_id text, target_external_item_id text, target_direction text, target_body text) to service_role;
grant execute on function public.record_scheduling_booking_provider_success(target_booking_intent_id uuid, target_external_appointment_id text, target_provider_status text) to service_role;
grant execute on function public.record_sms_delivery_submission(target_message_id uuid, target_provider_message_id text, target_provider_status text) to service_role;
grant execute on function public.record_stripe_billing_customer(target_checkout_id uuid, target_stripe_customer_id text, target_livemode boolean) to service_role;
grant execute on function public.record_stripe_checkout_session(target_checkout_id uuid, target_session_id text, target_customer_id text, target_expires_at timestamp with time zone, target_livemode boolean) to service_role;
grant execute on function public.record_stripe_webhook_event(target_event_id text, target_event_type text, target_object_id text, target_created_at timestamp with time zone, target_livemode boolean) to service_role;
grant execute on function public.record_twilio_message_status(target_provider_message_id text, target_status text, target_error_code text) to service_role;
grant execute on function public.record_voice_booking_provider_success(target_booking_intent_id uuid, target_external_appointment_id text, target_provider_status text) to service_role;
grant execute on function public.recover_stale_knowledge_imports(target_limit integer) to service_role;
grant execute on function public.recover_stale_knowledge_publish(target_import_id uuid) to authenticated;
grant execute on function public.recover_stale_lead_followup_submissions(target_limit integer) to service_role;
grant execute on function public.refresh_appointment_reminders(target_appointment_id uuid) to service_role;
grant execute on function public.register_runtime_instance(target_instance_id uuid, target_service text, target_release text) to service_role;
grant execute on function public.release_booking_slot_lease(target_booking_intent_id uuid) to service_role;
grant execute on function public.release_knowledge_publish(target_import_id uuid, safe_error_code text, safe_error_message text) to authenticated;
grant execute on function public.release_my_handoff(target_handoff_id uuid) to authenticated;
grant execute on function public.renew_knowledge_import_lease(target_import_id uuid, target_claim_token uuid, target_lease_seconds integer) to service_role;
grant execute on function public.request_agent_test_handoff(target_conversation_id uuid, tool_call_id text, handoff_reason text, handoff_urgency text) to authenticated;
grant execute on function public.request_inbound_voice_handoff(target_call_id text, target_tool_call_id text, target_reason text, target_urgency text) to service_role;
grant execute on function public.request_message_handoff(target_inbound_message_id uuid, target_tool_call_id text, target_reason text, target_urgency text) to service_role;
grant execute on function public.reserve_billing_checkout_subscription_from_event(target_session_id text, target_customer_id text, target_subscription_id text, target_livemode boolean) to service_role;
grant execute on function public.resolve_my_handoff(target_handoff_id uuid) to authenticated;
grant execute on function public.resume_my_conversation_ai(target_conversation_id uuid) to authenticated;
grant execute on function public.retry_message_processing_job(target_job_id uuid, target_error_code text) to service_role;
grant execute on function public.revoke_my_organization_invitation(target_invitation_id uuid) to authenticated;
grant execute on function public.revoke_my_organization_member(target_membership_id uuid) to authenticated;
grant execute on function public.save_ezyvet_catalog(target_integration_id uuid, appointment_types jsonb, resources jsonb, target_site_timezone text) to service_role;
grant execute on function public.save_google_calendar_resources(target_integration_id uuid, calendars jsonb) to service_role;
grant execute on function public.save_knowledge_import_pages(target_import_id uuid, crawled_pages jsonb, discovered_count integer, skipped_count integer, final_root_url text) to authenticated;
grant execute on function public.save_onboarding_business(business_name text, business_website_url text, normalized_business_phone text) to authenticated;
grant execute on function public.save_onboarding_industry(selected_industry_id text) to authenticated;
grant execute on function public.save_onboarding_location(location_name text, location_timezone text, location_address jsonb, location_business_hours jsonb) to authenticated;
grant execute on function public.set_my_active_scheduling_integration(target_location_id uuid, target_integration_id uuid, target_minimum_lead_minutes integer) to authenticated;
grant execute on function public.set_sms_phone_number_enabled(target_phone_number_id uuid, target_enabled boolean) to service_role;
grant execute on function public.set_sms_phone_number_enabled_for_user(target_user_id uuid, target_phone_number_id uuid, target_enabled boolean) to service_role;
grant execute on function public.set_voice_provider_transfer_capability(target_organization_id uuid, target_location_id uuid, target_enabled boolean) to service_role;
grant execute on function public.start_knowledge_import(target_import_id uuid) to authenticated;
grant execute on function public.stop_runtime_instance(target_instance_id uuid) to service_role;
grant execute on function public.store_ezyvet_connection(target_organization_id uuid, target_location_id uuid, target_client_id text, target_client_secret text, target_environment text, target_site_uid text, target_provider_site_id text, target_provider_timezone text) to service_role;
grant execute on function public.store_google_calendar_connection(target_organization_id uuid, target_location_id uuid, target_refresh_token text) to service_role;
grant execute on function public.take_over_my_conversation(target_conversation_id uuid) to authenticated;
grant execute on function public.update_knowledge_document_draft(target_document_id uuid, draft_title text, draft_content text, is_included boolean) to authenticated;
grant execute on function public.update_my_ezyvet_booking_policy(target_location_id uuid, selected_appointment_type_ids uuid[], selected_resource_ids uuid[]) to authenticated;
grant execute on function public.update_my_google_booking_policy(target_location_id uuid, selected_appointment_type_ids uuid[], selected_resource_ids uuid[], mappings jsonb) to authenticated;
grant execute on function public.update_my_organization_member_access(target_membership_id uuid, target_role text, target_location_ids uuid[]) to authenticated;
grant execute on function public.upsert_my_appointment_reminder_settings(target_location_id uuid, target_sms_enabled boolean, target_24h_enabled boolean, target_2h_enabled boolean, target_quiet_hours_start time without time zone, target_quiet_hours_end time without time zone) to authenticated;
grant execute on function public.upsert_my_lead_followup_settings(target_location_id uuid, target_enabled boolean, target_delay_minutes integer, target_quiet_hours_start time without time zone, target_quiet_hours_end time without time zone, target_business_hours_only boolean, target_sender_phone_number_id uuid, target_acknowledge_sender boolean) to authenticated;
grant execute on function public.upsert_my_voice_configuration(target_location_id uuid, target_enabled boolean, target_voice text, target_transfer_enabled boolean, target_transfer_target_e164 text) to authenticated;
grant execute on function public.upsert_my_web_chat_widget(target_location_id uuid, target_enabled boolean, target_allowed_origins jsonb, target_welcome_message text) to authenticated;
