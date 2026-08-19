-- Phase 11 consent and follow-up invariants. Fixtures deliberately use trusted transport fields,
-- never contacts.phone, to exercise the database authority boundary.
begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(52);

create function pg_temp.error_matches(target_sql text, expected_state text, message_pattern text)
returns boolean language plpgsql as $$
begin
  begin
    execute target_sql;
  exception when others then
    return sqlstate = expected_state and sqlerrm ~ message_pattern;
  end;
  return false;
end;
$$;

insert into auth.users (id, email) values
  ('f0000000-0000-0000-0000-000000000001', 'followup-owner@example.test'),
  ('f0000000-0000-0000-0000-000000000002', 'followup-member@example.test');
insert into public.organizations (id, name, slug, created_by, primary_industry_id) values
  ('f1000000-0000-0000-0000-000000000001', 'Follow-up Org', 'followup-org', 'f0000000-0000-0000-0000-000000000001', 'veterinary');
insert into public.locations (id, organization_id, name, timezone, business_hours) values
  ('f1100000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'Main clinic', 'UTC', '{"monday":{"open":"00:00","close":"23:59","closed":false},"tuesday":{"open":"00:00","close":"23:59","closed":false},"wednesday":{"open":"00:00","close":"23:59","closed":false},"thursday":{"open":"00:00","close":"23:59","closed":false},"friday":{"open":"00:00","close":"23:59","closed":false},"saturday":{"open":"00:00","close":"23:59","closed":false},"sunday":{"open":"00:00","close":"23:59","closed":false}}'),
  ('f1200000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'Other clinic', 'UTC', '{"monday":{"open":"00:00","close":"23:59","closed":false},"tuesday":{"open":"00:00","close":"23:59","closed":false},"wednesday":{"open":"00:00","close":"23:59","closed":false},"thursday":{"open":"00:00","close":"23:59","closed":false},"friday":{"open":"00:00","close":"23:59","closed":false},"saturday":{"open":"00:00","close":"23:59","closed":false},"sunday":{"open":"00:00","close":"23:59","closed":false}}');
insert into public.organization_members (id, organization_id, user_id, role) values
  ('f1300000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'owner'),
  ('f1300000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000002', 'member');
insert into public.organization_member_locations (organization_id, organization_member_id, location_id)
values ('f1000000-0000-0000-0000-000000000001', 'f1300000-0000-0000-0000-000000000002', 'f1100000-0000-0000-0000-000000000001');
insert into public.phone_numbers (id, organization_id, location_id, phone_number, status, sms_enabled) values
  ('f1400000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', '+14155550901', 'active', true),
  ('f1400000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'f1200000-0000-0000-0000-000000000001', '+14155550902', 'active', true);
insert into public.contacts (id, organization_id, location_id, first_name, phone) values
  ('f1500000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'Taylor', '+14155550101');
insert into public.channels (id, organization_id, location_id, channel_type, display_name, status) values
  ('f1600000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'sms', 'SMS', 'active'),
  ('f1600000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'phone', 'Phone', 'active');
insert into public.conversations (id, organization_id, location_id, contact_id, channel_id, transport_phone_number_id, mode, ai_mode, status) values
  ('f1700000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000001', 'f1400000-0000-0000-0000-000000000001', 'customer', 'ai', 'open'),
  ('f1700000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'f1600000-0000-0000-0000-000000000002', 'f1400000-0000-0000-0000-000000000001', 'customer', 'ai', 'open');
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164, created_at) values
  ('f1800000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'inbound', 'text', 'How much is a vaccination?', 'sms', 'customer', '+14155550101', now() - interval '2 minutes'),
  ('f1800000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000002', 'f1500000-0000-0000-0000-000000000001', 'inbound', 'voice_transcript', 'Would you like a text follow-up?', 'voice', 'customer', null, now() - interval '2 minutes');
insert into public.calls (id, organization_id, location_id, conversation_id, contact_id, phone_number_id, direction, status, provider, external_call_id, transport_caller_e164) values
  ('f1900000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000002', 'f1500000-0000-0000-0000-000000000001', 'f1400000-0000-0000-0000-000000000001', 'inbound', 'in_progress', 'openai-realtime-sip', 'followup-call-a', '+14155550101'),
  ('f1900000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000002', 'f1500000-0000-0000-0000-000000000001', 'f1400000-0000-0000-0000-000000000001', 'inbound', 'in_progress', 'openai-realtime-sip', 'followup-call-b', '+14155550102');

select extensions.ok((select pg_temp.error_matches($sql$ insert into public.sms_consents (organization_id,location_id,sender_phone_number_id,recipient_e164,purpose,status,source_type,source_message_id,granted_at) values ('f1000000-0000-0000-0000-000000000001','f1200000-0000-0000-0000-000000000001','f1400000-0000-0000-0000-000000000001','+14155550101','lead_followup','active','sms_start','f1800000-0000-0000-0000-000000000001',now()) $sql$, '23503', 'foreign key constraint.*')), 'consent sender must belong to the same location');
select extensions.ok((select pg_temp.error_matches($sql$ insert into public.sms_consents (organization_id,location_id,sender_phone_number_id,recipient_e164,purpose,status,source_type,source_message_id,granted_at) values ('f1000000-0000-0000-0000-000000000001','f1200000-0000-0000-0000-000000000001','f1400000-0000-0000-0000-000000000002','+14155550101','lead_followup','active','sms_start','f1800000-0000-0000-0000-000000000001',now()) $sql$, '23503', 'foreign key constraint.*')), 'consent source message must belong to the same location');
select extensions.ok((select pg_temp.error_matches($sql$ insert into public.sms_consents (organization_id,location_id,sender_phone_number_id,recipient_e164,purpose,status,source_type,source_message_id,source_call_id,granted_at) values ('f1000000-0000-0000-0000-000000000001','f1200000-0000-0000-0000-000000000001','f1400000-0000-0000-0000-000000000002','+14155550101','lead_followup','active','voice_explicit','f1800000-0000-0000-0000-000000000001','f1900000-0000-0000-0000-000000000001',now()) $sql$, '23503', 'foreign key constraint.*')), 'consent source call must belong to the same location');
select extensions.is((select count(*)::integer from public.sms_consents), 0, 'normal inbound SMS does not create follow-up consent');

insert into public.lead_followup_settings (organization_id, location_id, lead_followup_enabled, sender_phone_number_id, automation_acknowledged_at, automation_acknowledged_by, automation_acknowledged_sender_phone_number_id)
values ('f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', true, 'f1400000-0000-0000-0000-000000000001', now(), 'f0000000-0000-0000-0000-000000000001', 'f1400000-0000-0000-0000-000000000001');
insert into public.leads (id, organization_id, location_id, contact_id, conversation_id, last_captured_message_id, status, source_channel, service_category, customer_goal, urgency, qualification_reason, details)
values ('f1a00000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000001', 'qualified', 'sms', 'wellness', 'appointment', 'routine', 'qualified', '{}');
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164) values
  ('f1800000-0000-0000-0000-000000000003', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'inbound', 'text', 'START', 'sms', 'customer', '+14155550101');
insert into public.messaging_contact_preferences (organization_id, location_id, contact_id, channel_type, sender_phone_number_id, status, source_message_id)
values ('f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'sms', 'f1400000-0000-0000-0000-000000000001', 'active', 'f1800000-0000-0000-0000-000000000003');
select extensions.is((select status from public.sms_consents where recipient_e164 = '+14155550101'), 'active', 'START grants one active exact-route consent');
select extensions.is((select count(*)::integer from public.lead_followup_jobs where lead_id = 'f1a00000-0000-0000-0000-000000000001'), 1, 'consent after lead capture schedules one job');
select extensions.ok((select pg_temp.error_matches($sql$ insert into public.sms_consents (organization_id,location_id,sender_phone_number_id,recipient_e164,purpose,status,source_type,source_message_id,granted_at) values ('f1000000-0000-0000-0000-000000000001','f1100000-0000-0000-0000-000000000001','f1400000-0000-0000-0000-000000000001','+14155550101','lead_followup','active','sms_start','f1800000-0000-0000-0000-000000000003',now()) $sql$, '23505', 'duplicate key.*')), 'one exact route consent row is enforced');
update public.contacts set phone = '+14155550199' where id = 'f1500000-0000-0000-0000-000000000001';
select extensions.is((select recipient_e164 from public.lead_followup_jobs where lead_id = 'f1a00000-0000-0000-0000-000000000001'), '+14155550101', 'contacts.phone changes do not alter the snapshot recipient');
select extensions.ok((select pg_temp.error_matches($sql$ update public.lead_followup_jobs set recipient_e164 = '+14155550199' where lead_id = 'f1a00000-0000-0000-0000-000000000001' $sql$, '42501', 'snapshots are immutable')), 'job recipient snapshot is immutable');
select extensions.ok((select pg_temp.error_matches($sql$ update public.lead_followup_jobs set sender_e164 = '+14155550909' where lead_id = 'f1a00000-0000-0000-0000-000000000001' $sql$, '42501', 'snapshots are immutable')), 'job sender snapshot is immutable');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000002', true);
select extensions.ok((select pg_temp.error_matches($sql$ insert into public.sms_consents (organization_id,location_id,sender_phone_number_id,recipient_e164,purpose,status,source_type,source_message_id,granted_at) values ('f1000000-0000-0000-0000-000000000001','f1100000-0000-0000-0000-000000000001','f1400000-0000-0000-0000-000000000001','+14155550188','lead_followup','active','sms_start','f1800000-0000-0000-0000-000000000003',now()) $sql$, '42501', 'permission denied.*')), 'authenticated members cannot forge consent');
select extensions.is((select count(*)::integer from public.sms_consents), 1, 'location-scoped members can read the consent state for their location');
select extensions.ok((select pg_temp.error_matches($sql$ select public.upsert_my_lead_followup_settings('f1100000-0000-0000-0000-000000000001', true, 240, time '20:00', time '08:00', true, 'f1400000-0000-0000-0000-000000000001', true) $sql$, '42501', 'Follow-up settings are unavailable')), 'member cannot enable follow-up automation');
select extensions.ok((select pg_temp.error_matches($sql$ update public.lead_followup_jobs set status = 'sent' where lead_id = 'f1a00000-0000-0000-0000-000000000001' $sql$, '42501', 'permission denied.*')), 'authenticated users cannot mutate follow-up job state');
select extensions.ok((select pg_temp.error_matches($sql$ select public.suppress_lead_followups_for_conversation('f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'forged') $sql$, '42501', 'permission denied.*')), 'members cannot execute the internal conversation suppression helper');
select extensions.ok((select pg_temp.error_matches($sql$ select public.suppress_lead_followups_for_conversation('f2000000-0000-0000-0000-000000000001', 'f2100000-0000-0000-0000-000000000001', 'f2700000-0000-0000-0000-000000000001', 'cross_tenant') $sql$, '42501', 'permission denied.*')), 'members cannot invoke the helper against another tenant');
select extensions.is((select count(*)::integer from public.get_my_lead_followup_settings('f1100000-0000-0000-0000-000000000001')), 0, 'members cannot read owner-only follow-up configuration');
select extensions.ok((select pg_temp.error_matches($sql$ select * from public.prepare_voice_sms_followup_consent('followup-call-a', 'f1800000-0000-0000-0000-000000000002') $sql$, '42501', 'permission denied.*')), 'authenticated users cannot execute the Voice consent RPC');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
select extensions.lives_ok($$ select public.upsert_my_lead_followup_settings('f1100000-0000-0000-0000-000000000001', true, 240, time '20:00', time '08:00', true, 'f1400000-0000-0000-0000-000000000001', true) $$, 'owner can save acknowledged follow-up settings');
reset role;

create temporary table pg_temp.voice_state (intent_id uuid);
grant select, insert on table pg_temp.voice_state to service_role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
insert into pg_temp.voice_state select consent_intent_id from public.prepare_voice_sms_followup_consent('followup-call-a', 'f1800000-0000-0000-0000-000000000002');
select extensions.is((select count(*)::integer from pg_temp.voice_state), 1, 'service role prepares a call-bound consent intent');
select extensions.throws_ok($$ select * from public.confirm_voice_sms_followup_consent('followup-call-a', (select intent_id from pg_temp.voice_state), 'f1800000-0000-0000-0000-000000000002') $$, '42501', 'Voice consent confirmation is unavailable', 'same-turn Voice confirmation is denied');
select extensions.throws_ok($$ select * from public.confirm_voice_sms_followup_consent('followup-call-b', (select intent_id from pg_temp.voice_state), 'f1800000-0000-0000-0000-000000000002') $$, '42501', 'Voice consent intent is unavailable', 'another call and caller cannot confirm the intent');
reset role;

insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, created_at) values
  ('f1800000-0000-0000-0000-000000000004', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000002', 'f1500000-0000-0000-0000-000000000001', 'inbound', 'voice_transcript', 'no', 'voice', 'customer', now() + interval '1 second');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select granted from public.confirm_voice_sms_followup_consent('followup-call-a', (select intent_id from pg_temp.voice_state), 'f1800000-0000-0000-0000-000000000004')), false, 'later Voice no is denied');
reset role;
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, created_at) values
  ('f1800000-0000-0000-0000-000000000005', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000002', 'f1500000-0000-0000-0000-000000000001', 'inbound', 'voice_transcript', 'Would you like a text follow-up?', 'voice', 'customer', now() + interval '2 seconds'),
  ('f1800000-0000-0000-0000-000000000006', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000002', 'f1500000-0000-0000-0000-000000000001', 'inbound', 'voice_transcript', 'yes please', 'voice', 'customer', now() + interval '3 seconds');
truncate pg_temp.voice_state;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
insert into pg_temp.voice_state select consent_intent_id from public.prepare_voice_sms_followup_consent('followup-call-a', 'f1800000-0000-0000-0000-000000000005');
select extensions.is((select granted from public.confirm_voice_sms_followup_consent('followup-call-a', (select intent_id from pg_temp.voice_state), 'f1800000-0000-0000-0000-000000000006')), true, 'later exact Voice yes grants consent');
select extensions.is((select granted from public.confirm_voice_sms_followup_consent('followup-call-a', (select intent_id from pg_temp.voice_state), 'f1800000-0000-0000-0000-000000000006')), true, 'Voice confirmation replay is idempotent');
reset role;
select extensions.is((select count(*)::integer from public.sms_consents where recipient_e164 = '+14155550101'), 1, 'voice and START consent share one exact-route record');

update public.lead_followup_jobs set status = 'scheduled', scheduled_for = now() + interval '1 hour' where lead_id = 'f1a00000-0000-0000-0000-000000000001';
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164) values
  ('f1800000-0000-0000-0000-000000000008', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'inbound', 'text', 'I have another question.', 'sms', 'customer', '+14155550101');
select extensions.is((select status from public.lead_followup_jobs where lead_id = 'f1a00000-0000-0000-0000-000000000001'), 'skipped', 'a newer customer SMS immediately suppresses the pending follow-up');
update public.lead_followup_jobs set status = 'scheduled', scheduled_for = now() + interval '1 hour' where lead_id = 'f1a00000-0000-0000-0000-000000000001';
update public.leads set status = 'converted' where id = 'f1a00000-0000-0000-0000-000000000001';
select extensions.is((select status from public.lead_followup_jobs where lead_id = 'f1a00000-0000-0000-0000-000000000001'), 'skipped', 'conversion immediately suppresses unsent follow-up work');

insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164) values
  ('f1800000-0000-0000-0000-000000000007', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'inbound', 'text', 'STOP', 'sms', 'customer', '+14155550101');
update public.messaging_contact_preferences set status = 'opted_out', opted_out_at = now(), source_message_id = 'f1800000-0000-0000-0000-000000000007'
where organization_id = 'f1000000-0000-0000-0000-000000000001' and location_id = 'f1100000-0000-0000-0000-000000000001'
  and contact_id = 'f1500000-0000-0000-0000-000000000001' and sender_phone_number_id = 'f1400000-0000-0000-0000-000000000001';
select extensions.is((select status from public.sms_consents where recipient_e164 = '+14155550101'), 'revoked', 'STOP revokes exact-route consent');
select extensions.is((select status from public.lead_followup_jobs where lead_id = 'f1a00000-0000-0000-0000-000000000001'), 'skipped', 'STOP immediately suppresses unsent follow-up work');

insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, source_channel, author_type, transport_sender_e164) values
  ('f1800000-0000-0000-0000-000000000009', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'inbound', 'text', 'UNSTOP', 'sms', 'customer', '+14155550101');
update public.messaging_contact_preferences set status = 'active', opted_out_at = null, source_message_id = 'f1800000-0000-0000-0000-000000000009'
where organization_id = 'f1000000-0000-0000-0000-000000000001' and location_id = 'f1100000-0000-0000-0000-000000000001'
  and contact_id = 'f1500000-0000-0000-0000-000000000001' and sender_phone_number_id = 'f1400000-0000-0000-0000-000000000001';
select extensions.is((select status from public.sms_consents where recipient_e164 = '+14155550101'), 'active', 'UNSTOP regrants consent after the canonical preference state is active');
select extensions.ok((select has_function_privilege('authenticated', 'public.suppress_lead_followups_for_conversation(uuid,uuid,uuid,text)', 'execute') is false), 'authenticated has no direct suppression-helper grant');
select extensions.ok((select has_function_privilege('service_role', 'public.suppress_lead_followups_for_conversation(uuid,uuid,uuid,text)', 'execute') is false), 'service role has no direct suppression-helper grant');

insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, sent_at) values
  ('f1800000-0000-0000-0000-000000000010', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'outbound', 'text', 'A queued follow-up', '{"kind":"lead_followup"}', 'sms', 'system', now());
insert into public.message_deliveries (organization_id, location_id, message_id, provider)
values ('f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000010', 'twilio');
update public.lead_followup_jobs set status = 'delivery_pending', message_id = 'f1800000-0000-0000-0000-000000000010',
  delivery_id = (select id from public.message_deliveries where message_id = 'f1800000-0000-0000-0000-000000000010'), skip_reason = null, failure_reason = null
where lead_id = 'f1a00000-0000-0000-0000-000000000001';
update public.message_deliveries set status = 'submitted', attempted_at = now() where message_id = 'f1800000-0000-0000-0000-000000000010';
select extensions.is((select status from public.lead_followup_jobs where lead_id = 'f1a00000-0000-0000-0000-000000000001'), 'sent', 'provider submission projects the follow-up job to sent');
update public.conversations set ai_mode = 'human' where id = 'f1700000-0000-0000-0000-000000000001';
select extensions.ok((select (select status from public.message_deliveries where message_id = 'f1800000-0000-0000-0000-000000000010') = 'submitted'
  and (select status from public.lead_followup_jobs where lead_id = 'f1a00000-0000-0000-0000-000000000001') = 'sent'), 'suppression leaves submitted provider truth untouched');
update public.message_deliveries set status = 'undelivered', error_code = 'carrier_error' where message_id = 'f1800000-0000-0000-0000-000000000010';
select extensions.is((select status from public.lead_followup_jobs where lead_id = 'f1a00000-0000-0000-0000-000000000001'), 'failed', 'a real later delivery failure projects the follow-up job to failed');

insert into public.leads (id, organization_id, location_id, contact_id, conversation_id, last_captured_message_id, status, source_channel, service_category, customer_goal, urgency, qualification_reason, details)
values ('f1a00000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000003', 'converted', 'sms', 'wellness', 'appointment', 'routine', 'qualified', '{}');
insert into public.lead_followup_jobs (organization_id, location_id, lead_id, conversation_id, consent_id, sender_phone_number_id, sender_e164, recipient_e164, trigger_message_id, status, skip_reason)
values ('f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1a00000-0000-0000-0000-000000000002', 'f1700000-0000-0000-0000-000000000001', (select id from public.sms_consents where recipient_e164 = '+14155550101'), 'f1400000-0000-0000-0000-000000000001', '+14155550901', '+14155550101', 'f1800000-0000-0000-0000-000000000003', 'skipped', 'frequency_cap');
select extensions.ok((select exists (select 1 from public.action_logs log join public.lead_followup_jobs job on job.id = log.entity_id where job.lead_id = 'f1a00000-0000-0000-0000-000000000002' and log.action = 'lead.followup.skipped')), 'initial skipped jobs are audited');

insert into public.leads (id, organization_id, location_id, contact_id, conversation_id, last_captured_message_id, status, source_channel, service_category, customer_goal, urgency, qualification_reason, details)
values ('f1a00000-0000-0000-0000-000000000003', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000003', 'converted', 'sms', 'wellness', 'appointment', 'routine', 'qualified', '{}');
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, sent_at) values
  ('f1800000-0000-0000-0000-000000000011', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'outbound', 'text', 'A queued follow-up', '{"kind":"lead_followup"}', 'sms', 'system', now());
insert into public.message_deliveries (organization_id, location_id, message_id, provider)
values ('f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000011', 'twilio');
insert into public.lead_followup_jobs (id, organization_id, location_id, lead_id, conversation_id, consent_id, sender_phone_number_id, sender_e164, recipient_e164, trigger_message_id, message_id, delivery_id, status)
values ('f1b00000-0000-0000-0000-000000000003', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1a00000-0000-0000-0000-000000000003', 'f1700000-0000-0000-0000-000000000001', (select id from public.sms_consents where recipient_e164 = '+14155550101'), 'f1400000-0000-0000-0000-000000000001', '+14155550901', '+14155550101', 'f1800000-0000-0000-0000-000000000003', 'f1800000-0000-0000-0000-000000000011', (select id from public.message_deliveries where message_id = 'f1800000-0000-0000-0000-000000000011'), 'delivery_pending');
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
select public.upsert_my_lead_followup_settings('f1100000-0000-0000-0000-000000000001', false, 240, time '20:00', time '08:00', true, null, false);
reset role;
select extensions.is((select status from public.lead_followup_jobs where lead_id = 'f1a00000-0000-0000-0000-000000000003'), 'skipped', 'disabling follow-ups suppresses an unsent queued job');
select extensions.is((select status from public.message_deliveries where message_id = 'f1800000-0000-0000-0000-000000000011'), 'suppressed', 'disabling follow-ups suppresses its queued delivery before provider submission');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select count(*)::integer from public.claim_lead_followup_delivery('f1b00000-0000-0000-0000-000000000003')), 0, 'a disabled follow-up never receives a delivery submission claim');
select extensions.throws_ok($$ select * from public.prepare_voice_sms_followup_consent('followup-call-a', 'f1800000-0000-0000-0000-000000000005') $$, '42501', 'Voice follow-up consent is unavailable', 'disabled follow-up settings block new Voice consent preparation');
reset role;

insert into public.phone_numbers (id, organization_id, location_id, phone_number, status, sms_enabled)
values ('f1400000-0000-0000-0000-000000000003', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', '+14155550903', 'active', true);
insert into public.leads (id, organization_id, location_id, contact_id, conversation_id, last_captured_message_id, status, source_channel, service_category, customer_goal, urgency, qualification_reason, details)
values ('f1a00000-0000-0000-0000-000000000004', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000003', 'converted', 'sms', 'wellness', 'appointment', 'routine', 'qualified', '{}');
insert into public.lead_followup_jobs (organization_id, location_id, lead_id, conversation_id, consent_id, sender_phone_number_id, sender_e164, recipient_e164, trigger_message_id, status, scheduled_for)
values ('f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1a00000-0000-0000-0000-000000000004', 'f1700000-0000-0000-0000-000000000001', (select id from public.sms_consents where recipient_e164 = '+14155550101'), 'f1400000-0000-0000-0000-000000000001', '+14155550901', '+14155550101', 'f1800000-0000-0000-0000-000000000003', 'scheduled', now() + interval '1 hour');
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
select public.upsert_my_lead_followup_settings('f1100000-0000-0000-0000-000000000001', true, 240, time '20:00', time '08:00', true, 'f1400000-0000-0000-0000-000000000003', true);
reset role;
select extensions.is((select automation_acknowledged_sender_phone_number_id from public.lead_followup_settings where location_id = 'f1100000-0000-0000-0000-000000000001'), 'f1400000-0000-0000-0000-000000000003'::uuid, 'sender acknowledgement is tied to the newly selected exact sender');
select extensions.is((select status from public.lead_followup_jobs where lead_id = 'f1a00000-0000-0000-0000-000000000004'), 'skipped', 'changing the sender suppresses pending unsent follow-up work');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.throws_ok($$ select * from public.prepare_voice_sms_followup_consent('followup-call-a', 'f1800000-0000-0000-0000-000000000005') $$, '42501', 'Voice follow-up consent is unavailable', 'Voice consent cannot use an active call DID that differs from the selected sender');
reset role;

insert into public.leads (id, organization_id, location_id, contact_id, conversation_id, last_captured_message_id, status, source_channel, service_category, customer_goal, urgency, qualification_reason, details)
values ('f1a00000-0000-0000-0000-000000000005', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000003', 'converted', 'sms', 'wellness', 'appointment', 'routine', 'qualified', '{}');
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, sent_at) values
  ('f1800000-0000-0000-0000-000000000012', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'outbound', 'text', 'A stale follow-up', '{"kind":"lead_followup"}', 'sms', 'system', now());
insert into public.message_deliveries (organization_id, location_id, message_id, provider)
values ('f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000012', 'twilio');
insert into public.lead_followup_jobs (organization_id, location_id, lead_id, conversation_id, consent_id, sender_phone_number_id, sender_e164, recipient_e164, trigger_message_id, message_id, delivery_id, status)
values ('f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1a00000-0000-0000-0000-000000000005', 'f1700000-0000-0000-0000-000000000001', (select id from public.sms_consents where recipient_e164 = '+14155550101'), 'f1400000-0000-0000-0000-000000000001', '+14155550901', '+14155550101', 'f1800000-0000-0000-0000-000000000003', 'f1800000-0000-0000-0000-000000000012', (select id from public.message_deliveries where message_id = 'f1800000-0000-0000-0000-000000000012'), 'delivery_pending');
update public.message_deliveries set status = 'submitting', attempted_at = now() - interval '6 minutes' where message_id = 'f1800000-0000-0000-0000-000000000012';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.lives_ok($$ select public.recover_stale_lead_followup_submissions(10) $$, 'service recovery marks stale submitting follow-up deliveries unknown without retrying');
reset role;
select extensions.is((select status from public.message_deliveries where message_id = 'f1800000-0000-0000-0000-000000000012'), 'unknown', 'stale follow-up submission becomes unknown');
select extensions.is((select status from public.lead_followup_jobs where lead_id = 'f1a00000-0000-0000-0000-000000000005'), 'failed', 'stale submission recovery marks the follow-up failed');

update public.conversations set ai_mode = 'ai' where id = 'f1700000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-000000000001', true);
select public.upsert_my_lead_followup_settings('f1100000-0000-0000-0000-000000000001', true, 240, time '20:00', time '08:00', true, 'f1400000-0000-0000-0000-000000000001', true);
reset role;
insert into public.leads (id, organization_id, location_id, contact_id, conversation_id, last_captured_message_id, status, source_channel, service_category, customer_goal, urgency, qualification_reason, details)
values
  ('f1a00000-0000-0000-0000-000000000006', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000003', 'converted', 'sms', 'wellness', 'appointment', 'routine', 'qualified', '{}'),
  ('f1a00000-0000-0000-0000-000000000007', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000003', 'converted', 'sms', 'wellness', 'appointment', 'routine', 'qualified', '{}');
insert into public.messages (id, organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, sent_at) values
  ('f1800000-0000-0000-0000-000000000013', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'outbound', 'text', 'A prior follow-up', '{"kind":"lead_followup"}', 'sms', 'system', now()),
  ('f1800000-0000-0000-0000-000000000014', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1700000-0000-0000-0000-000000000001', 'f1500000-0000-0000-0000-000000000001', 'outbound', 'text', 'A capped follow-up', '{"kind":"lead_followup"}', 'sms', 'system', now());
insert into public.message_deliveries (organization_id, location_id, message_id, provider, status, attempted_at)
values
  ('f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000013', 'twilio', 'submitted', now()),
  ('f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1800000-0000-0000-0000-000000000014', 'twilio');
insert into public.lead_followup_jobs (id, organization_id, location_id, lead_id, conversation_id, consent_id, sender_phone_number_id, sender_e164, recipient_e164, trigger_message_id, message_id, delivery_id, status)
values
  ('f1b00000-0000-0000-0000-000000000006', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1a00000-0000-0000-0000-000000000006', 'f1700000-0000-0000-0000-000000000001', (select id from public.sms_consents where recipient_e164 = '+14155550101'), 'f1400000-0000-0000-0000-000000000001', '+14155550901', '+14155550101', 'f1800000-0000-0000-0000-000000000003', 'f1800000-0000-0000-0000-000000000013', (select id from public.message_deliveries where message_id = 'f1800000-0000-0000-0000-000000000013'), 'delivery_pending'),
  ('f1b00000-0000-0000-0000-000000000007', 'f1000000-0000-0000-0000-000000000001', 'f1100000-0000-0000-0000-000000000001', 'f1a00000-0000-0000-0000-000000000007', 'f1700000-0000-0000-0000-000000000001', (select id from public.sms_consents where recipient_e164 = '+14155550101'), 'f1400000-0000-0000-0000-000000000001', '+14155550901', '+14155550101', 'f1800000-0000-0000-0000-000000000003', 'f1800000-0000-0000-0000-000000000014', (select id from public.message_deliveries where message_id = 'f1800000-0000-0000-0000-000000000014'), 'delivery_pending');
update public.leads set status = 'qualified' where id = 'f1a00000-0000-0000-0000-000000000007';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select extensions.is((select count(*)::integer from public.claim_lead_followup_delivery('f1b00000-0000-0000-0000-000000000007')), 0, 'the 24-hour route cap denies a second submission before Twilio is called');
reset role;
select extensions.ok((select (select status from public.lead_followup_jobs where lead_id = 'f1a00000-0000-0000-0000-000000000007') = 'skipped'
  and (select status from public.message_deliveries where message_id = 'f1800000-0000-0000-0000-000000000014') = 'suppressed'), 'the capped job and queued delivery are suppressed without a provider attempt');
select extensions.is((select public.lead_followup_next_allowed_time('2026-08-24 22:00:00+00', 'UTC', time '20:00', time '08:00', '{}'::jsonb, false)), '2026-08-25 08:00:00+00'::timestamptz, 'quiet-hours scheduling moves forward, never earlier');
select extensions.ok((select has_table_privilege('service_role', 'public.sms_consents', 'select') is false), 'service role receives no direct consent table grant');
select extensions.ok((select has_table_privilege('service_role', 'public.lead_followup_jobs', 'select') is false), 'service role receives no direct follow-up job table grant');

select * from extensions.finish();
rollback;
