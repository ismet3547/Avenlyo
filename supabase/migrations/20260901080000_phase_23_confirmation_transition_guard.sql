-- Phase 23 follow-up: defend the current runtime even though the legacy claim names remain for
-- rollback compatibility. A Phase 23 text action is identifiable by its non-null
-- confirmation_prompt_message_id. Only those rows are subject to this guard; an older rollback
-- binary creates rows with the column null and keeps its historical call shape.

create function public.get_customer_booking_confirmation_snapshot(target_booking_intent_id uuid)
returns table (
  booking_intent_id uuid,
  subject_name text,
  appointment_type_name text,
  starts_at timestamptz,
  timezone text,
  location_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.require_scheduling_service_role();
  return query
  select intent.id,
    coalesce(nullif(btrim(intent.subject_name), ''), 'Customer')::text,
    appointment_type.name,
    candidate.starts_at,
    candidate.timezone,
    location.name
  from public.booking_intents intent
  join public.booking_candidates candidate
    on candidate.organization_id = intent.organization_id
   and candidate.id = intent.candidate_id
  join public.scheduling_appointment_types appointment_type
    on appointment_type.organization_id = intent.organization_id
   and appointment_type.id = candidate.appointment_type_id
  join public.locations location
    on location.organization_id = intent.organization_id
   and location.id = intent.location_id
  where intent.id = target_booking_intent_id
    and intent.status = 'awaiting_confirmation'
    and candidate.status in ('offered', 'consumed')
    and candidate.expires_at > now();
end;
$$;

create function public.enforce_presented_booking_confirmation_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prompt public.messages%rowtype;
  confirmed public.messages%rowtype;
begin
  if old.status = 'awaiting_confirmation'
    and new.status = 'booking'
    and old.confirmation_prompt_message_id is not null then
    if new.confirmed_message_id is null
      or not public.customer_mutation_confirmation_prompt_is_visible(
        old.confirmation_prompt_message_id, old.conversation_id
      ) then
      raise exception using errcode = '42501', message = 'Presented booking confirmation is required';
    end if;
    select * into prompt
    from public.messages
    where id = old.confirmation_prompt_message_id
      and organization_id = old.organization_id
      and location_id = old.location_id
      and conversation_id = old.conversation_id
      and direction = 'outbound'
      and author_type = 'ai';
    select * into confirmed
    from public.messages
    where id = new.confirmed_message_id
      and organization_id = old.organization_id
      and location_id = old.location_id
      and conversation_id = old.conversation_id
      and direction = 'inbound'
      and author_type = 'customer';
    if prompt.id is null or confirmed.id is null or confirmed.created_at < prompt.created_at then
      raise exception using errcode = '42501', message = 'Presented booking confirmation is required';
    end if;
  end if;
  return new;
end;
$$;

create trigger booking_intents_presented_confirmation_transition
before update of status, confirmed_message_id on public.booking_intents
for each row execute function public.enforce_presented_booking_confirmation_transition();

create function public.enforce_presented_appointment_change_confirmation_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prompt public.messages%rowtype;
  confirmed public.messages%rowtype;
begin
  if old.actor_category = 'customer'
    and old.status = 'awaiting_confirmation'
    and new.status = 'executing'
    and old.confirmation_prompt_message_id is not null then
    if new.confirmed_message_id is null
      or not public.customer_mutation_confirmation_prompt_is_visible(
        old.confirmation_prompt_message_id, old.conversation_id
      ) then
      raise exception using errcode = '42501', message = 'Presented appointment-change confirmation is required';
    end if;
    select * into prompt
    from public.messages
    where id = old.confirmation_prompt_message_id
      and organization_id = old.organization_id
      and location_id = old.location_id
      and conversation_id = old.conversation_id
      and direction = 'outbound'
      and author_type = 'ai';
    select * into confirmed
    from public.messages
    where id = new.confirmed_message_id
      and organization_id = old.organization_id
      and location_id = old.location_id
      and conversation_id = old.conversation_id
      and direction = 'inbound'
      and author_type = 'customer';
    if prompt.id is null or confirmed.id is null or confirmed.created_at < prompt.created_at then
      raise exception using errcode = '42501', message = 'Presented appointment-change confirmation is required';
    end if;
  end if;
  return new;
end;
$$;

create trigger appointment_change_intents_presented_confirmation_transition
before update of status, confirmed_message_id on public.appointment_change_intents
for each row execute function public.enforce_presented_appointment_change_confirmation_transition();

revoke all on function public.get_customer_booking_confirmation_snapshot(uuid)
  from public, anon, authenticated;
grant execute on function public.get_customer_booking_confirmation_snapshot(uuid)
  to service_role;
revoke all on function public.enforce_presented_booking_confirmation_transition()
  from public, anon, authenticated, service_role;
revoke all on function public.enforce_presented_appointment_change_confirmation_transition()
  from public, anon, authenticated, service_role;
