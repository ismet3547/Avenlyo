-- Phase 10 executable database checks. They verify service-only mutation and location isolation;
-- they do not simulate model/provider calls.

begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(17);

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
insert into public.channels (id, organization_id, location_id, channel_type, display_name, status) values
  ('e1400000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'web', 'Web A one', 'active'),
  ('e1500000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1200000-0000-0000-0000-000000000001', 'web', 'Web A two', 'active'),
  ('e2400000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'e2100000-0000-0000-0000-000000000001', 'web', 'Web B', 'active');
insert into public.conversations (id, organization_id, location_id, channel_id, mode, ai_mode, status) values
  ('e1600000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1400000-0000-0000-0000-000000000001', 'customer', 'ai', 'open'),
  ('e1700000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1200000-0000-0000-0000-000000000001', 'e1500000-0000-0000-0000-000000000001', 'customer', 'ai', 'open'),
  ('e2600000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'e2100000-0000-0000-0000-000000000001', 'e2400000-0000-0000-0000-000000000001', 'customer', 'ai', 'open');
insert into public.messages (id, organization_id, location_id, conversation_id, direction, message_type, body, source_channel, author_type) values
  ('e1800000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000001', 'inbound', 'text', 'I want a wellness appointment.', 'web', 'customer'),
  ('e1900000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1200000-0000-0000-0000-000000000001', 'e1700000-0000-0000-0000-000000000001', 'inbound', 'text', 'Location two lead.', 'web', 'customer'),
  ('e2800000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'e2100000-0000-0000-0000-000000000001', 'e2600000-0000-0000-0000-000000000001', 'inbound', 'text', 'Other org lead.', 'web', 'customer');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select state from public.capture_conversation_lead('e1800000-0000-0000-0000-000000000001', 'lead-tool-1', 'wellness', 'routine', 'appointment', 'Alex', '{"species":"dog"}', 'qualified')), 'qualified', 'trusted service captures a qualified web lead');
select extensions.is((select state from public.capture_conversation_lead('e1800000-0000-0000-0000-000000000001', 'lead-tool-1', 'wellness', 'routine', 'appointment', 'Alex', '{"species":"dog"}', 'qualified')), 'qualified', 'same inbound tool replay is idempotent');
reset role;
select extensions.is((select count(*)::integer from public.leads where conversation_id = 'e1600000-0000-0000-0000-000000000001'), 1, 'one active lead exists for the captured conversation');
select extensions.is((select details ->> 'customer_name' from public.leads where conversation_id = 'e1600000-0000-0000-0000-000000000001'), 'Alex', 'customer display name is retained in lead details');
select extensions.is((select count(*)::integer from public.lead_capture_tool_calls where conversation_id = 'e1600000-0000-0000-0000-000000000001'), 1, 'duplicate model tool call does not duplicate audit state');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select state from public.capture_conversation_lead('e1800000-0000-0000-0000-000000000001', 'lead-tool-2', 'grooming', 'routine', 'appointment', null, '{}', 'qualified')), 'needs_clarification', 'contradictory service category does not overwrite the lead');
reset role;
select extensions.is((select service_category from public.leads where conversation_id = 'e1600000-0000-0000-0000-000000000001'), 'wellness', 'known captured category remains immutable on conflict');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000002', true);
select extensions.is((select count(*)::integer from public.get_my_leads(null, null, null, null)), 1, 'location-scoped member reads leads at their assigned location only');
select extensions.is((select count(*)::integer from public.get_my_inbox_lead_indicators(null)), 1, 'location-scoped member receives only permitted inbox indicators');
select extensions.throws_ok($$ update public.leads set status = 'converted' where conversation_id = 'e1600000-0000-0000-0000-000000000001' $$, '42501', 'authenticated members cannot directly mutate lead state');
select extensions.throws_ok($$ select * from public.capture_conversation_lead('e1800000-0000-0000-0000-000000000001', 'forged', 'wellness', 'routine', 'appointment', null, '{}', 'qualified') $$, '42501', 'authenticated clients cannot execute service-only lead capture');
reset role;

insert into public.integrations (id, organization_id, location_id, provider, status, environment)
values ('e1a00000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'ezyvet', 'disabled', 'trial');
insert into public.scheduling_appointment_types (id, organization_id, location_id, integration_id, provider, external_uid, name, default_duration_minutes, active, bookable)
values ('e1b00000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1a00000-0000-0000-0000-000000000001', 'ezyvet', 'wellness', 'Wellness', 30, true, true);
insert into public.scheduling_resources (id, organization_id, location_id, integration_id, provider, external_uid, name, external_ownership_id, active, bookable)
values ('e1c00000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1a00000-0000-0000-0000-000000000001', 'ezyvet', 'doctor-a', 'Doctor A', 'practice-a', true, true);
insert into public.booking_candidates (id, organization_id, location_id, conversation_id, integration_id, appointment_type_id, resource_id, starts_at, ends_at, timezone, expires_at)
values ('e1d00000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000001', 'e1a00000-0000-0000-0000-000000000001', 'e1b00000-0000-0000-0000-000000000001', 'e1c00000-0000-0000-0000-000000000001', now() + interval '1 day', now() + interval '1 day 30 minutes', 'UTC', now() + interval '1 hour');
insert into public.booking_intents (id, organization_id, location_id, conversation_id, integration_id, candidate_id, status)
values ('e1e00000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000001', 'e1a00000-0000-0000-0000-000000000001', 'e1d00000-0000-0000-0000-000000000001', 'completed');
insert into public.appointments (id, organization_id, location_id, conversation_id, title, status, starts_at, ends_at, provider, integration_id, booking_intent_id)
values ('e1f00000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000001', 'Wellness', 'confirmed', now() + interval '1 day', now() + interval '1 day 30 minutes', 'ezyvet', 'e1a00000-0000-0000-0000-000000000001', 'e1e00000-0000-0000-0000-000000000001');
select extensions.lives_ok($$ select public.convert_booking_lead('e1e00000-0000-0000-0000-000000000001', 'e1f00000-0000-0000-0000-000000000001') $$, 'durable appointment persistence converts the active conversation lead');
select extensions.is((select status from public.leads where conversation_id = 'e1600000-0000-0000-0000-000000000001'), 'converted', 'booking conversion updates the active lead exactly once');
select public.convert_booking_lead('e1e00000-0000-0000-0000-000000000001', 'e1f00000-0000-0000-0000-000000000001');
select extensions.is((select count(*)::integer from public.action_logs where entity_type = 'lead' and action = 'lead.converted' and organization_id = 'e1000000-0000-0000-0000-000000000001'), 1, 'booking conversion recovery is idempotent and does not duplicate audit events');

insert into public.leads (organization_id, location_id, conversation_id, status, source_channel, urgency, details)
values ('e1000000-0000-0000-0000-000000000001', 'e1200000-0000-0000-0000-000000000001', 'e1700000-0000-0000-0000-000000000001', 'new', 'web', 'unknown', '{}');
insert into public.leads (organization_id, location_id, conversation_id, status, source_channel, urgency, details)
values ('e2000000-0000-0000-0000-000000000001', 'e2100000-0000-0000-0000-000000000001', 'e2600000-0000-0000-0000-000000000001', 'new', 'web', 'unknown', '{}');
select extensions.throws_ok($$
  insert into public.leads (organization_id, location_id, conversation_id, status, source_channel, urgency, conversion_appointment_id, details)
  values ('e1000000-0000-0000-0000-000000000001', 'e1100000-0000-0000-0000-000000000001', 'e1600000-0000-0000-0000-000000000001', 'lost', 'web', 'unknown', 'e2800000-0000-0000-0000-000000000001', '{}')
$$, '23503', 'cross-organization appointment references are rejected by the composite foreign key');
select extensions.ok((select has_table_privilege('service_role', 'public.leads', 'select') is false), 'service_role receives no direct lead table select grant');
select extensions.ok((select has_function_privilege('authenticated', 'public.capture_conversation_lead(uuid,text,text,text,text,text,jsonb,text,text)', 'execute') is false), 'lead capture RPC remains service-role only');

select * from extensions.finish();
rollback;
