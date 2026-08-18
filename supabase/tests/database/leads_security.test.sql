-- Phase 10 executable security and lifecycle checks. These use only local fixtures and SQL RPCs.
-- Error assertions intentionally match SQLSTATE plus a stable pattern, not PostgreSQL's full wording.

begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(42);

insert into auth.users (id, email) values
  ('e0000000-0000-0000-0000-000000000001', 'lead-owner@example.test'),
  ('e0000000-0000-0000-0000-000000000002', 'lead-member@example.test'),
  ('e0000000-0000-0000-0000-000000000003', 'lead-owner-b@example.test');
insert into public.organizations (id, name, slug, created_by, primary_industry_id) values
  ('e1000000-0000-0000-0000-000000000001', 'Lead A', 'lead-a', 'e0000000-0000-0000-0000-000000000001', 'veterinary'),
  ('e2000000-0000-0000-0000-000000000001', 'Lead B', 'lead-b', 'e0000000-0000-0000-0000-000000000003', 'auto-repair');
insert into public.locations (id, organization_id, name, timezone) values
  ('e1100000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'Lead A one', 'UTC'),
  ('e1200000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'Lead A two', 'UTC'),
  ('e2100000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'Lead B one', 'UTC');
insert into public.organization_members (id, organization_id, user_id, role) values
  ('e1300000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'owner'),
  ('e1300000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002', 'member'),
  ('e2300000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000003', 'owner');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
values ('e1000000-0000-0000-0000-000000000001', 'e1300000-0000-0000-0000-000000000002', 'e1100000-0000-0000-0000-000000000001');

insert into public.contacts (id, organization_id, location_id, first_name) values
  ('e1110000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'Alex'),
  ('e1210000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1200000-0000-0000-0000-000000000001', 'Blair');
insert into public.channels (id, organization_id, location_id, channel_type, display_name, status) values
  ('e1400000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'web', 'Web A one', 'active'),
  ('e1410000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'phone', 'Phone A one', 'active'),
  ('e1500000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1200000-0000-0000-0000-000000000001', 'web', 'Web A two', 'active'),
  ('e2400000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'e2100000-0000-0000-0000-000000000001', 'web', 'Web B', 'active');
insert into public.conversations (id, organization_id, location_id, contact_id, channel_id, mode, ai_mode, status) values
  ('e1600000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1110000-0000-0000-0000-000000000001', 'e1400000-0000-0000-0000-000000000001', 'customer', 'ai', 'open'),
  ('e1630000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1110000-0000-0000-0000-000000000001', 'e1400000-0000-0000-0000-000000000001', 'customer', 'ai', 'open'),
  ('e1610000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', null, 'e1410000-0000-0000-0000-000000000001', 'customer', 'ai', 'open'),
  ('e1620000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1110000-0000-0000-0000-000000000001', 'e1400000-0000-0000-0000-000000000001', 'customer', 'ai', 'open'),
  ('e1700000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1200000-0000-0000-0000-000000000001', 'e1210000-0000-0000-0000-000000000001', 'e1500000-0000-0000-0000-000000000001', 'customer', 'ai', 'open'),
  ('e2600000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'e2100000-0000-0000-0000-000000000001', null, 'e2400000-0000-0000-0000-000000000001', 'customer', 'ai', 'open');
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, external_id, source_channel, author_type) values
  ('e1800000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000001', 'e1110000-0000-0000-0000-000000000001', 'inbound', 'text', 'I want a wellness appointment.', 'lead-web-1', 'web', 'customer'),
  ('e1810000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000001', 'e1110000-0000-0000-0000-000000000001', 'inbound', 'text', 'This is now urgent.', 'lead-web-2', 'web', 'customer'),
  ('e1830000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1630000-0000-0000-0000-000000000001', 'e1110000-0000-0000-0000-000000000001', 'inbound', 'text', 'Please help my dog.', 'lead-web-3', 'web', 'customer'),
  ('e1840000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1620000-0000-0000-0000-000000000001', 'e1110000-0000-0000-0000-000000000001', 'inbound', 'text', 'I need an appointment.', 'lead-web-minimal', 'web', 'customer'),
  ('e1820000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1610000-0000-0000-0000-000000000001', null, 'inbound', 'voice_transcript', 'I need a wellness appointment.', 'voice:anonymous-call:item-1', 'voice', 'customer'),
  ('e1900000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1200000-0000-0000-0000-000000000001', 'e1700000-0000-0000-0000-000000000001', 'e1210000-0000-0000-0000-000000000001', 'inbound', 'text', 'Location two lead.', 'lead-web-location-two', 'web', 'customer'),
  ('e2800000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'e2100000-0000-0000-0000-000000000001', 'e2600000-0000-0000-0000-000000000001', null, 'inbound', 'text', 'Other org lead.', 'lead-web-other-org', 'web', 'customer');
insert into public.calls (id, organization_id, location_id, conversation_id, direction, status, provider, external_call_id, transport_caller_e164) values
  ('e1c10000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1610000-0000-0000-0000-000000000001', 'inbound', 'in_progress', 'openai-realtime-sip', 'anonymous-call', null),
  ('e1c20000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1630000-0000-0000-0000-000000000001', 'inbound', 'in_progress', 'openai-realtime-sip', 'wrong-conversation-call', null);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select state from public.capture_conversation_lead('e1800000-0000-0000-0000-000000000001', 'lead-tool-1', 'wellness', 'routine', 'appointment', 'Alex', '{"species":"dog"}', 'qualified')), 'qualified', 'trusted service captures an initially qualified web lead');
select extensions.is((select state from public.capture_conversation_lead('e1800000-0000-0000-0000-000000000001', 'lead-tool-1', 'wellness', 'routine', 'appointment', 'Alex', '{"species":"dog"}', 'qualified')), 'qualified', 'same inbound tool replay is idempotent');
reset role;
select extensions.is((select count(*)::integer from public.leads where conversation_id = 'e1600000-0000-0000-0000-000000000001'), 1, 'one active lead exists after replayed capture');
select extensions.is((select count(*)::integer from public.lead_capture_tool_calls where conversation_id = 'e1600000-0000-0000-0000-000000000001'), 1, 'replayed tool call creates one durable replay record');
select extensions.is((select count(*)::integer from public.action_logs where entity_type = 'lead' and action = 'lead.created'), 1, 'initial lead capture writes one lead.created audit event');
select extensions.is((select count(*)::integer from public.action_logs where entity_type = 'lead' and action = 'lead.qualified'), 1, 'initially qualified lead also writes one lead.qualified audit event');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select state from public.capture_conversation_lead('e1800000-0000-0000-0000-000000000001', 'lead-tool-conflict-qualified', 'grooming', 'routine', 'appointment', null, '{}', 'qualified')), 'needs_clarification', 'qualified lead conflict takes precedence over qualified state');
select extensions.is((select state from public.capture_conversation_lead('e1830000-0000-0000-0000-000000000001', 'lead-tool-new', 'wellness', 'routine', 'appointment', null, '{}', 'needs_more_information')), 'needs_more_information', 'new lead is captured before a conflicting follow-up');
select extensions.is((select state from public.capture_conversation_lead('e1830000-0000-0000-0000-000000000001', 'lead-tool-conflict-new', 'grooming', 'routine', 'appointment', null, '{}', 'qualified')), 'needs_clarification', 'new lead conflict also takes precedence');
reset role;
select extensions.is((select service_category from public.leads where conversation_id = 'e1600000-0000-0000-0000-000000000001'), 'wellness', 'qualified lead keeps its conflicting category');
select extensions.is((select service_category from public.leads where conversation_id = 'e1630000-0000-0000-0000-000000000001'), 'wellness', 'new lead keeps its conflicting category');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select state from public.capture_conversation_lead('e1810000-0000-0000-0000-000000000001', 'lead-tool-urgent', 'wellness', 'urgent', 'appointment', null, '{}', 'needs_human')), 'needs_human', 'urgent follow-up requests a human handoff');
reset role;
select extensions.is((select urgency from public.leads where conversation_id = 'e1600000-0000-0000-0000-000000000001'), 'urgent', 'later urgent capture upgrades durable urgency');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select state from public.capture_conversation_lead('e1810000-0000-0000-0000-000000000001', 'lead-tool-routine', 'wellness', 'routine', 'appointment', null, '{}', 'qualified')), 'qualified', 'lower urgency follow-up remains a valid capture');
reset role;
select extensions.is((select urgency from public.leads where conversation_id = 'e1600000-0000-0000-0000-000000000001'), 'urgent', 'later routine capture cannot downgrade urgency');
select extensions.is((select count(*)::integer from public.leads where conversation_id = 'e1600000-0000-0000-0000-000000000001' and status in ('new', 'qualified')), 1, 'repeated captures keep one active lead');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select state from public.capture_conversation_lead('e1820000-0000-0000-0000-000000000001', 'voice-anonymous-lead', 'wellness', 'soon', 'appointment', null, '{}', 'qualified', 'anonymous-call')), 'qualified', 'anonymous voice caller can capture a lead from the exact persisted transcript');
select extensions.throws_ok($$ select * from public.capture_conversation_lead('e1820000-0000-0000-0000-000000000001', 'voice-wrong-conversation', 'wellness', 'soon', 'appointment', null, '{}', 'qualified', 'wrong-conversation-call') $$, '42501', 'Trusted customer transport is unavailable', 'voice capture rejects a real call from another conversation');
reset role;

insert into public.leads (id, organization_id, location_id, contact_id, conversation_id, status, source_channel, urgency, details)
values ('e1f10000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1200000-0000-0000-0000-000000000001', 'e1210000-0000-0000-0000-000000000001', 'e1700000-0000-0000-0000-000000000001', 'qualified', 'web', 'unknown', '{}');
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000002', true);
select extensions.is((select count(*)::integer from public.get_my_leads(null, null, null, null)), 3, 'location-scoped member reads only leads at the assigned location');
select extensions.is((select count(*)::integer from public.get_my_lead_detail('e1f10000-0000-0000-0000-000000000001')), 0, 'location-scoped member cannot read an unrelated location lead');
select extensions.throws_ok($$ update public.leads set status = 'converted' where conversation_id = 'e1600000-0000-0000-0000-000000000001' $$, '42501', '.*permission denied.*', 'authenticated members cannot directly mutate lead state');
select extensions.throws_ok($$ select * from public.capture_conversation_lead('e1800000-0000-0000-0000-000000000001', 'forged', 'wellness', 'routine', 'appointment', null, '{}', 'qualified') $$, '42501', '.*permission denied.*', 'authenticated clients cannot execute service-only lead capture');
select extensions.throws_ok($$ select public.convert_booking_lead('e1e00000-0000-0000-0000-000000000001', 'e1f00000-0000-0000-0000-000000000001') $$, '42501', '.*permission denied.*', 'authenticated clients cannot execute service-only conversion');
reset role;

insert into public.appointments (id, organization_id, location_id, conversation_id, title, status, starts_at, ends_at)
values
  ('e1f20000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1200000-0000-0000-0000-000000000001', 'e1700000-0000-0000-0000-000000000001', 'Location two appointment', 'confirmed', now() + interval '2 days', now() + interval '2 days 30 minutes'),
  ('e2f20000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'e2100000-0000-0000-0000-000000000001', 'e2600000-0000-0000-0000-000000000001', 'Other organization appointment', 'confirmed', now() + interval '2 days', now() + interval '2 days 30 minutes');
select extensions.throws_ok($$ insert into public.leads (organization_id, location_id, contact_id, status, details) values ('e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1210000-0000-0000-0000-000000000001', 'lost', '{}') $$, '23503', '.*foreign key constraint.*', 'lead cannot reference a contact from another location');
select extensions.throws_ok($$ insert into public.leads (organization_id, location_id, conversation_id, status, details) values ('e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1700000-0000-0000-0000-000000000001', 'lost', '{}') $$, '23503', '.*foreign key constraint.*', 'lead cannot reference a conversation from another location');
select extensions.throws_ok($$ insert into public.leads (organization_id, location_id, conversation_id, last_captured_message_id, status, details) values ('e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000001', 'e1900000-0000-0000-0000-000000000001', 'lost', '{}') $$, '23503', '.*foreign key constraint.*', 'lead cannot reference a captured message from another location');
select extensions.throws_ok($$ insert into public.leads (organization_id, location_id, conversation_id, conversion_appointment_id, status, details) values ('e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000001', 'e1f20000-0000-0000-0000-000000000001', 'lost', '{}') $$, '23503', '.*foreign key constraint.*', 'lead cannot reference a conversion appointment from another location');
select extensions.throws_ok($$ insert into public.leads (organization_id, location_id, conversation_id, conversion_appointment_id, status, details) values ('e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000001', 'e2f20000-0000-0000-0000-000000000001', 'lost', '{}') $$, '23503', '.*foreign key constraint.*', 'lead cannot reference a conversion appointment from another organization');
select extensions.throws_ok($$ insert into public.lead_capture_tool_calls (organization_id, location_id, conversation_id, inbound_message_id, tool_call_id, lead_id, result_state) values ('e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000001', 'e1830000-0000-0000-0000-000000000001', 'mismatched-message', (select id from public.leads where conversation_id = 'e1600000-0000-0000-0000-000000000001'), 'qualified') $$, '23503', '.*foreign key constraint.*', 'tool call cannot bind a message from another conversation');
select extensions.throws_ok($$ insert into public.lead_capture_tool_calls (organization_id, location_id, conversation_id, inbound_message_id, tool_call_id, lead_id, result_state) values ('e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000001', 'e1800000-0000-0000-0000-000000000001', 'mismatched-lead', (select id from public.leads where conversation_id = 'e1630000-0000-0000-0000-000000000001'), 'qualified') $$, '23503', '.*foreign key constraint.*', 'tool call cannot bind a lead from another conversation');
select extensions.throws_ok($$ insert into public.lead_capture_tool_calls (organization_id, location_id, conversation_id, inbound_message_id, tool_call_id, lead_id, result_state) values ('e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1700000-0000-0000-0000-000000000001', 'e1800000-0000-0000-0000-000000000001', 'mismatched-conversation', (select id from public.leads where conversation_id = 'e1600000-0000-0000-0000-000000000001'), 'qualified') $$, '23503', '.*foreign key constraint.*', 'tool call cannot bind a conversation from another location');

insert into public.integrations (id, organization_id, location_id, provider, status, environment)
values ('e1a00000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'ezyvet', 'disabled', 'trial');
insert into public.scheduling_appointment_types (id, organization_id, location_id, integration_id, provider, external_uid, name, default_duration_minutes, active, bookable)
values ('e1b00000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1a00000-0000-0000-0000-000000000001', 'ezyvet', 'wellness', 'Wellness', 30, true, true);
insert into public.scheduling_resources (id, organization_id, location_id, integration_id, provider, external_uid, name, external_ownership_id, active, bookable)
values ('e1c00000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1a00000-0000-0000-0000-000000000001', 'ezyvet', 'doctor-a', 'Doctor A', 'practice-a', true, true);
insert into public.booking_candidates (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at)
values ('e1d00000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1620000-0000-0000-0000-000000000001', 'e1a00000-0000-0000-0000-000000000001', 'e1b00000-0000-0000-0000-000000000001', 'e1c00000-0000-0000-0000-000000000001', now() + interval '1 day', now() + interval '1 day 30 minutes', 'UTC', now() + interval '1 hour');
insert into public.booking_intents (id, organization_id, location_id, conversation_id, integration_id, candidate_id, status, completed_at)
values ('e1e00000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1620000-0000-0000-0000-000000000001', 'e1a00000-0000-0000-0000-000000000001', 'e1d00000-0000-0000-0000-000000000001', 'completed', now());
insert into public.appointments (id, organization_id, location_id, contact_id, conversation_id, title, status, starts_at, ends_at, provider, integration_id, booking_intent_id)
values ('e1f00000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1110000-0000-0000-0000-000000000001', 'e1620000-0000-0000-0000-000000000001', 'Wellness', 'requested', now() + interval '1 day', now() + interval '1 day 30 minutes', 'ezyvet', 'e1a00000-0000-0000-0000-000000000001', 'e1e00000-0000-0000-0000-000000000001');
select extensions.throws_ok($$ select public.convert_booking_lead('e1e00000-0000-0000-0000-000000000001', 'e1f00000-0000-0000-0000-000000000001') $$, '22023', 'Booking conversion context is invalid', 'conversion is denied before a confirmed local appointment exists');
update public.appointments set status = 'confirmed' where id = 'e1f00000-0000-0000-0000-000000000001';
select extensions.lives_ok($$ select public.convert_booking_lead('e1e00000-0000-0000-0000-000000000001', 'e1f00000-0000-0000-0000-000000000001') $$, 'confirmed completed booking converts a minimal lead');
select extensions.is((select status from public.leads where conversation_id = 'e1620000-0000-0000-0000-000000000001'), 'converted', 'successful booking conversion creates a converted lead');
select extensions.is((select count(*)::integer from public.action_logs where entity_type = 'lead' and entity_id = (select id from public.leads where conversation_id = 'e1620000-0000-0000-0000-000000000001') and action = 'lead.created'), 1, 'minimal conversion writes lead.created exactly once');
select extensions.is((select count(*)::integer from public.action_logs where entity_type = 'lead' and entity_id = (select id from public.leads where conversation_id = 'e1620000-0000-0000-0000-000000000001') and action = 'lead.converted'), 1, 'minimal conversion writes lead.converted exactly once');
select public.convert_booking_lead('e1e00000-0000-0000-0000-000000000001', 'e1f00000-0000-0000-0000-000000000001');
select extensions.is((select count(*)::integer from public.action_logs where entity_type = 'lead' and entity_id = (select id from public.leads where conversation_id = 'e1620000-0000-0000-0000-000000000001') and action = 'lead.converted'), 1, 'booking conversion replay does not duplicate audit history');
update public.appointments set status = 'cancelled' where id = 'e1f00000-0000-0000-0000-000000000001';
select extensions.is((select status from public.leads where conversation_id = 'e1620000-0000-0000-0000-000000000001'), 'converted', 'later appointment lifecycle changes do not reopen a converted lead');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000002', true);
select extensions.ok((select exists(select 1 from public.get_my_inbox_lead_indicators(null) where conversation_id = 'e1620000-0000-0000-0000-000000000001' and lead_status = 'converted')), 'inbox indicators retain converted lead lifecycle truth');
reset role;
select extensions.ok((select has_table_privilege('service_role', 'public.leads', 'select') is false), 'service_role receives no direct lead table select grant');
select extensions.ok((select has_function_privilege('authenticated', 'public.capture_conversation_lead(uuid,text,text,text,text,text,jsonb,text,text)', 'execute') is false), 'lead capture RPC remains service-role only');
select extensions.ok((select has_function_privilege('authenticated', 'public.convert_booking_lead(uuid,uuid)', 'execute') is false), 'lead conversion RPC remains unavailable to authenticated clients');

select * from extensions.finish();
rollback;
