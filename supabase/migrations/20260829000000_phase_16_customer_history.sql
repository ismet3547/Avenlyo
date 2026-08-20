-- Phase 16: Customer 360 and conversation history.
--
-- Everything here is a read boundary over truth Avenlyo already stores. No new customer table, no
-- identity resolution, no summarization, and no provider call. `public.contacts` remains the
-- canonical person record; "Customers" is only what the operator calls it.
--
-- Two rules shape every function below.
--
-- Location is the operational scope. A member assigned to one location must never learn customer
-- history from another, and that has to hold even for a contact who is genuinely active at both.
-- Counts, timelines, and transcripts are therefore all filtered by the selected location rather than
-- by the organization.
--
-- Visibility follows activity, not the contact row. `contacts.location_id` records where a person
-- was first seen; it is not a claim about where they have since been active. Deriving visibility
-- from it would both hide people who moved and expose people who never came back.

-- ============================================================================
-- 1. Bounds
-- ============================================================================

-- One page is small enough that a slow query is a bug rather than a fact of life, and small enough
-- that no single response can become a bulk export of customer records.
create function public.customer_history_page_limit(requested integer)
returns integer language sql immutable set search_path = '' as $$
  select least(greatest(coalesce(requested, 25), 1), 50);
$$;

-- Deterministic presentation, computed once so every surface agrees. Never generated, never
-- inferred: an operator reading a name here is reading something a customer actually provided.
create function public.contact_display_name(
  first_name text,
  last_name text,
  phone text,
  email text
)
returns text language sql immutable set search_path = '' as $$
  select coalesce(
    nullif(btrim(concat_ws(' ', nullif(btrim(coalesce(first_name, '')), ''),
                                nullif(btrim(coalesce(last_name, '')), ''))), ''),
    nullif(btrim(coalesce(phone, '')), ''),
    nullif(btrim(coalesce(email, '')), ''),
    'Customer'
  );
$$;

-- ============================================================================
-- 2. Visibility
-- ============================================================================

-- Resolves the organization for a location the caller may actually use, or null.
--
-- Every read model starts here rather than accepting an organization_id argument, because an
-- organization the browser names is a claim and a location the caller can prove access to is a
-- fact. `has_location_access` already carries Phase 15 active-membership semantics, so a revoked
-- member loses every customer surface on their next request.
create function public.my_customer_location_organization(target_location_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select location.organization_id
  from public.locations as location
  where location.id = target_location_id
    and public.has_location_access(location.organization_id, location.id);
$$;

-- Durable production evidence that this person interacted with this location.
--
-- Test-agent activity is deliberately absent: a synthetic conversation someone ran to try the
-- product is not customer history, and showing it would make the directory lie about who the
-- business has actually spoken to.
create function public.contact_has_location_activity(
  target_organization_id uuid,
  target_location_id uuid,
  target_contact_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.conversations as conversation
    where conversation.organization_id = target_organization_id
      and conversation.location_id = target_location_id
      and conversation.contact_id = target_contact_id
      and conversation.mode = 'customer'
  ) or exists (
    -- A call inherits production status from its conversation when it has one. A call with no
    -- conversation came from the voice transport, which has no test mode.
    select 1 from public.calls as call
    left join public.conversations as conversation
      on conversation.organization_id = call.organization_id
      and conversation.id = call.conversation_id
    where call.organization_id = target_organization_id
      and call.location_id = target_location_id
      and call.contact_id = target_contact_id
      and (call.conversation_id is null or conversation.mode = 'customer')
  ) or exists (
    select 1 from public.leads as lead
    where lead.organization_id = target_organization_id
      and lead.location_id = target_location_id
      and lead.contact_id = target_contact_id
  ) or exists (
    select 1 from public.appointments as appointment
    where appointment.organization_id = target_organization_id
      and appointment.location_id = target_location_id
      and appointment.contact_id = target_contact_id
  );
$$;

-- The combined check the product means by "this staff member may look at this customer".
create function public.contact_visible_at_location(
  target_organization_id uuid,
  target_location_id uuid,
  target_contact_id uuid
)
returns boolean language sql stable security definer set search_path = '' as $$
  select target_contact_id is not null
    and public.my_customer_location_organization(target_location_id) = target_organization_id
    and public.contact_has_location_activity(
      target_organization_id, target_location_id, target_contact_id);
$$;

-- ============================================================================
-- 3. Customer directory
-- ============================================================================
--
-- One bounded query per page. Each activity family is aggregated once against the location rather
-- than correlated per row, so adding a customer costs a row rather than five more subqueries.

create function public.get_my_customer_directory(
  target_location_id uuid,
  target_search text default null,
  cursor_last_activity_at timestamptz default null,
  cursor_contact_id uuid default null,
  page_limit integer default 25
)
returns table (
  contact_id uuid,
  display_name text,
  first_name text,
  last_name text,
  phone text,
  email text,
  first_activity_at timestamptz,
  last_activity_at timestamptz,
  conversation_count integer,
  call_count integer,
  appointment_count integer,
  lead_status text,
  sms_opted_out boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  organization uuid;
  bounded_limit integer := public.customer_history_page_limit(page_limit);
  normalized_search text;
begin
  organization := public.my_customer_location_organization(target_location_id);
  if organization is null then
    -- Says nothing about whether the location exists. An unauthorized caller and a nonexistent
    -- location are indistinguishable from here.
    return;
  end if;

  -- Search terms are customer PII, so they are bounded and never logged. A one-character term is
  -- refused rather than silently scanning the whole directory.
  normalized_search := nullif(btrim(coalesce(target_search, '')), '');
  if normalized_search is not null then
    if char_length(normalized_search) < 2 or char_length(normalized_search) > 120 then
      raise exception using errcode = '22023', message = 'Customer search is invalid';
    end if;
  end if;

  return query
  with production_conversations as (
    select conversation.contact_id, conversation.id, conversation.created_at,
      coalesce(conversation.last_message_at, conversation.created_at) as activity_at
    from public.conversations as conversation
    where conversation.organization_id = organization
      and conversation.location_id = target_location_id
      and conversation.mode = 'customer'
      and conversation.contact_id is not null
  ),
  production_calls as (
    select call.contact_id, call.id,
      coalesce(call.started_at, call.created_at) as activity_at
    from public.calls as call
    left join public.conversations as conversation
      on conversation.organization_id = call.organization_id
      and conversation.id = call.conversation_id
    where call.organization_id = organization
      and call.location_id = target_location_id
      and call.contact_id is not null
      and (call.conversation_id is null or conversation.mode = 'customer')
  ),
  location_appointments as (
    select appointment.contact_id, appointment.id, appointment.starts_at as activity_at,
      appointment.created_at
    from public.appointments as appointment
    where appointment.organization_id = organization
      and appointment.location_id = target_location_id
      and appointment.contact_id is not null
  ),
  location_leads as (
    select lead.contact_id, lead.id, lead.status, lead.created_at, lead.updated_at
    from public.leads as lead
    where lead.organization_id = organization
      and lead.location_id = target_location_id
      and lead.contact_id is not null
  ),
  -- Every activity family, reduced to one row per contact for this location only.
  activity as (
    select
      candidate.contact_id,
      min(candidate.first_at) as first_activity_at,
      max(candidate.last_at) as last_activity_at,
      sum(candidate.conversations)::integer as conversation_count,
      sum(candidate.calls)::integer as call_count,
      sum(candidate.appointments)::integer as appointment_count
    from (
      select contact_id, min(created_at) as first_at, max(activity_at) as last_at,
        count(*)::integer as conversations, 0 as calls, 0 as appointments
      from production_conversations group by contact_id
      union all
      select contact_id, min(activity_at), max(activity_at), 0, count(*)::integer, 0
      from production_calls group by contact_id
      union all
      select contact_id, min(created_at), max(activity_at), 0, 0, count(*)::integer
      from location_appointments group by contact_id
      union all
      select contact_id, min(created_at), max(updated_at), 0, 0, 0
      from location_leads group by contact_id
    ) as candidate
    group by candidate.contact_id
  ),
  latest_lead as (
    select distinct on (lead.contact_id) lead.contact_id, lead.status
    from location_leads as lead
    order by lead.contact_id, lead.created_at desc, lead.id desc
  )
  select
    contact.id,
    public.contact_display_name(contact.first_name, contact.last_name, contact.phone, contact.email),
    contact.first_name,
    contact.last_name,
    contact.phone,
    contact.email,
    activity.first_activity_at,
    activity.last_activity_at,
    activity.conversation_count,
    activity.call_count,
    activity.appointment_count,
    latest_lead.status,
    -- Consent is read from its own durable record, never inferred from having a phone number or
    -- having replied once.
    coalesce(preference.status = 'opted_out', false)
  from activity
  join public.contacts as contact
    on contact.organization_id = organization and contact.id = activity.contact_id
  left join latest_lead on latest_lead.contact_id = activity.contact_id
  left join public.messaging_contact_preferences as preference
    on preference.organization_id = organization
    and preference.contact_id = activity.contact_id
    and preference.channel_type = 'sms'
  where (
    normalized_search is null
    or contact.first_name ilike '%' || normalized_search || '%'
    or contact.last_name ilike '%' || normalized_search || '%'
    or contact.phone ilike '%' || normalized_search || '%'
    or contact.email ilike '%' || normalized_search || '%'
  )
  -- Keyset pagination on a stable tuple. Every directory contact has activity by construction, so
  -- last_activity_at is never null; coalesce keeps the comparison total anyway rather than letting
  -- a legacy row silently drop out of the page sequence.
  and (
    cursor_last_activity_at is null
    or (coalesce(activity.last_activity_at, 'epoch'::timestamptz), contact.id)
       < (cursor_last_activity_at, coalesce(cursor_contact_id, '00000000-0000-0000-0000-000000000000'::uuid))
  )
  order by coalesce(activity.last_activity_at, 'epoch'::timestamptz) desc, contact.id desc
  limit bounded_limit;
end;
$$;

-- ============================================================================
-- 4. Customer overview
-- ============================================================================

create function public.get_my_customer_overview(
  target_location_id uuid,
  target_contact_id uuid
)
returns table (
  contact_id uuid,
  display_name text,
  first_name text,
  last_name text,
  phone text,
  email text,
  first_activity_at timestamptz,
  last_activity_at timestamptz,
  conversation_count integer,
  call_count integer,
  appointment_count integer,
  lead_count integer,
  lead_status text,
  lead_id uuid,
  next_appointment_id uuid,
  next_appointment_title text,
  next_appointment_status text,
  next_appointment_starts_at timestamptz,
  recent_appointment_id uuid,
  recent_appointment_title text,
  recent_appointment_status text,
  recent_appointment_starts_at timestamptz,
  sms_opted_out boolean,
  sms_opted_out_at timestamptz,
  active_handoff_count integer,
  active_handoff_urgency text,
  human_owned_conversation_count integer
)
language plpgsql stable security definer set search_path = '' as $$
declare
  organization uuid;
begin
  organization := public.my_customer_location_organization(target_location_id);
  -- A guessed contact id, a contact from another organization, and a contact with no activity at
  -- this location all produce the same empty result. Nothing distinguishes "not yours" from
  -- "does not exist".
  if organization is null
    or not public.contact_has_location_activity(organization, target_location_id, target_contact_id) then
    return;
  end if;

  return query
  with production_conversations as (
    select conversation.id, conversation.created_at, conversation.ai_mode,
      coalesce(conversation.last_message_at, conversation.created_at) as activity_at
    from public.conversations as conversation
    where conversation.organization_id = organization
      and conversation.location_id = target_location_id
      and conversation.contact_id = target_contact_id
      and conversation.mode = 'customer'
  ),
  production_calls as (
    select call.id, coalesce(call.started_at, call.created_at) as activity_at
    from public.calls as call
    left join public.conversations as conversation
      on conversation.organization_id = call.organization_id
      and conversation.id = call.conversation_id
    where call.organization_id = organization
      and call.location_id = target_location_id
      and call.contact_id = target_contact_id
      and (call.conversation_id is null or conversation.mode = 'customer')
  ),
  location_appointments as (
    select appointment.id, appointment.title, appointment.status,
      appointment.starts_at, appointment.created_at
    from public.appointments as appointment
    where appointment.organization_id = organization
      and appointment.location_id = target_location_id
      and appointment.contact_id = target_contact_id
  ),
  location_leads as (
    select lead.id, lead.status, lead.created_at, lead.updated_at
    from public.leads as lead
    where lead.organization_id = organization
      and lead.location_id = target_location_id
      and lead.contact_id = target_contact_id
  ),
  -- Live human work on this customer's conversations, at this location.
  active_handoffs as (
    select handoff.id, handoff.urgency
    from public.handoffs as handoff
    join production_conversations as conversation on conversation.id = handoff.conversation_id
    where handoff.organization_id = organization
      and handoff.mode = 'customer'
      and handoff.status in ('open', 'acknowledged')
  )
  select
    contact.id,
    public.contact_display_name(contact.first_name, contact.last_name, contact.phone, contact.email),
    contact.first_name,
    contact.last_name,
    contact.phone,
    contact.email,
    least(
      (select min(created_at) from production_conversations),
      (select min(activity_at) from production_calls),
      (select min(created_at) from location_appointments),
      (select min(created_at) from location_leads)
    ),
    greatest(
      (select max(activity_at) from production_conversations),
      (select max(activity_at) from production_calls),
      (select max(starts_at) from location_appointments),
      (select max(updated_at) from location_leads)
    ),
    (select count(*)::integer from production_conversations),
    (select count(*)::integer from production_calls),
    (select count(*)::integer from location_appointments),
    (select count(*)::integer from location_leads),
    -- The newest lead's own status. No invented customer lifecycle sits on top of it.
    (select status from location_leads order by created_at desc, id desc limit 1),
    (select id from location_leads order by created_at desc, id desc limit 1),
    upcoming.id, upcoming.title, upcoming.status, upcoming.starts_at,
    recent.id, recent.title, recent.status, recent.starts_at,
    coalesce(preference.status = 'opted_out', false),
    preference.opted_out_at,
    (select count(*)::integer from active_handoffs),
    -- Urgent wins when several are open, because that is the one an operator needs to see.
    (select case when bool_or(urgency = 'urgent') then 'urgent' else 'normal' end
     from active_handoffs),
    (select count(*)::integer from production_conversations where ai_mode = 'human')
  from public.contacts as contact
  left join lateral (
    select appointment.id, appointment.title, appointment.status, appointment.starts_at
    from location_appointments as appointment
    where appointment.starts_at >= now() and appointment.status in ('requested', 'confirmed')
    order by appointment.starts_at asc
    limit 1
  ) as upcoming on true
  left join lateral (
    select appointment.id, appointment.title, appointment.status, appointment.starts_at
    from location_appointments as appointment
    where appointment.starts_at < now()
    order by appointment.starts_at desc
    limit 1
  ) as recent on true
  left join public.messaging_contact_preferences as preference
    on preference.organization_id = organization
    and preference.contact_id = contact.id
    and preference.channel_type = 'sms'
  where contact.organization_id = organization and contact.id = target_contact_id;
end;
$$;

-- ============================================================================
-- 5. Customer activity timeline
-- ============================================================================
--
-- Event-summary oriented on purpose. Pouring every message from every conversation into one page
-- would make a long-standing customer unopenable and would duplicate the transcript, which has its
-- own bounded read model.

create function public.get_my_customer_timeline(
  target_location_id uuid,
  target_contact_id uuid,
  cursor_event_at timestamptz default null,
  cursor_event_kind text default null,
  cursor_event_id uuid default null,
  page_limit integer default 25
)
returns table (
  event_kind text,
  event_id uuid,
  event_at timestamptz,
  conversation_id uuid,
  title text,
  status text,
  detail text,
  channel text,
  ai_mode text,
  message_count integer,
  ends_at timestamptz,
  has_active_handoff boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare
  organization uuid;
  bounded_limit integer := public.customer_history_page_limit(page_limit);
begin
  organization := public.my_customer_location_organization(target_location_id);
  if organization is null
    or not public.contact_has_location_activity(organization, target_location_id, target_contact_id) then
    return;
  end if;

  return query
  with events as (
    -- Conversation episodes. Message count comes from a bounded per-conversation aggregate, not a
    -- correlated count over the whole message table.
    select
      'conversation'::text as event_kind,
      conversation.id as event_id,
      coalesce(conversation.last_message_at, conversation.created_at) as event_at,
      conversation.id as conversation_id,
      null::text as title,
      conversation.status,
      channel.channel_type as detail,
      coalesce(channel.channel_type, 'web')::text as channel,
      conversation.ai_mode,
      coalesce(message_totals.total, 0)::integer as message_count,
      null::timestamptz as ends_at,
      exists (
        select 1 from public.handoffs as handoff
        where handoff.organization_id = organization
          and handoff.conversation_id = conversation.id
          and handoff.mode = 'customer'
          and handoff.status in ('open', 'acknowledged')
      ) as has_active_handoff
    from public.conversations as conversation
    left join public.channels as channel
      on channel.organization_id = conversation.organization_id
      and channel.id = conversation.channel_id
    left join lateral (
      select count(*) as total from public.messages as message
      where message.organization_id = conversation.organization_id
        and message.conversation_id = conversation.id
    ) as message_totals on true
    where conversation.organization_id = organization
      and conversation.location_id = target_location_id
      and conversation.contact_id = target_contact_id
      and conversation.mode = 'customer'

    union all

    -- Calls. Provider identifiers, SIP identifiers, and raw metadata are deliberately absent.
    select
      'call'::text,
      call.id,
      coalesce(call.started_at, call.created_at),
      call.conversation_id,
      null::text,
      call.status,
      call.direction,
      'voice'::text,
      null::text,
      null::integer,
      call.ended_at,
      false
    from public.calls as call
    left join public.conversations as conversation
      on conversation.organization_id = call.organization_id
      and conversation.id = call.conversation_id
    where call.organization_id = organization
      and call.location_id = target_location_id
      and call.contact_id = target_contact_id
      and (call.conversation_id is null or conversation.mode = 'customer')

    union all

    select
      'appointment'::text,
      appointment.id,
      appointment.starts_at,
      appointment.conversation_id,
      appointment.title,
      appointment.status,
      null::text,
      null::text,
      null::text,
      null::integer,
      appointment.ends_at,
      false
    from public.appointments as appointment
    where appointment.organization_id = organization
      and appointment.location_id = target_location_id
      and appointment.contact_id = target_contact_id

    union all

    -- Lead status and source only. The details JSON stays where it is; the Lead page owns it.
    select
      'lead'::text,
      lead.id,
      lead.created_at,
      lead.conversation_id,
      null::text,
      lead.status,
      lead.source,
      lead.source_channel,
      null::text,
      null::integer,
      null::timestamptz,
      false
    from public.leads as lead
    where lead.organization_id = organization
      and lead.location_id = target_location_id
      and lead.contact_id = target_contact_id

    union all

    -- Handoffs carry status and urgency only. The reason text is operator-facing prose written for
    -- the Inbox, and the idempotency key is internal.
    select
      'handoff'::text,
      handoff.id,
      handoff.created_at,
      handoff.conversation_id,
      null::text,
      handoff.status,
      handoff.urgency,
      null::text,
      null::text,
      null::integer,
      handoff.resolved_at,
      handoff.status in ('open', 'acknowledged')
    from public.handoffs as handoff
    join public.conversations as conversation
      on conversation.organization_id = handoff.organization_id
      and conversation.id = handoff.conversation_id
    where handoff.organization_id = organization
      and handoff.mode = 'customer'
      and conversation.location_id = target_location_id
      and conversation.contact_id = target_contact_id
      and conversation.mode = 'customer'
  )
  select
    events.event_kind, events.event_id, events.event_at, events.conversation_id,
    events.title, events.status, events.detail, events.channel, events.ai_mode,
    events.message_count, events.ends_at, events.has_active_handoff
  from events
  -- Newest first with a total tie-breaker, so two events at the same instant always page in the
  -- same order and a cursor can neither duplicate nor skip one.
  where cursor_event_at is null
    or (events.event_at, events.event_kind, events.event_id)
       < (cursor_event_at, coalesce(cursor_event_kind, ''),
          coalesce(cursor_event_id, '00000000-0000-0000-0000-000000000000'::uuid))
  order by events.event_at desc, events.event_kind desc, events.event_id desc
  limit bounded_limit;
end;
$$;

-- ============================================================================
-- 6. Conversation archive
-- ============================================================================
--
-- Not the Inbox. The Inbox is an action queue about ownership; this is the historical record, and
-- it is read-only by construction because no mutation RPC is reachable from it.

create function public.get_my_conversation_archive(
  target_location_id uuid,
  target_channel text default null,
  target_status text default null,
  target_search text default null,
  cursor_activity_at timestamptz default null,
  cursor_conversation_id uuid default null,
  page_limit integer default 25
)
returns table (
  conversation_id uuid,
  contact_id uuid,
  customer_display_name text,
  channel text,
  status text,
  ai_mode text,
  created_at timestamptz,
  last_activity_at timestamptz,
  message_count integer,
  assigned_display_name text,
  active_handoff_status text,
  active_handoff_urgency text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  organization uuid;
  bounded_limit integer := public.customer_history_page_limit(page_limit);
  normalized_search text;
begin
  organization := public.my_customer_location_organization(target_location_id);
  if organization is null then
    return;
  end if;

  -- Filters are validated against the canonical state sets rather than passed through, so a
  -- crafted value cannot widen the result or reach the query as free text.
  if target_channel is not null and target_channel not in ('sms', 'web', 'voice') then
    raise exception using errcode = '22023', message = 'Conversation channel filter is invalid';
  end if;
  if target_status is not null and target_status not in ('open', 'pending', 'closed') then
    raise exception using errcode = '22023', message = 'Conversation status filter is invalid';
  end if;

  normalized_search := nullif(btrim(coalesce(target_search, '')), '');
  if normalized_search is not null
    and (char_length(normalized_search) < 2 or char_length(normalized_search) > 120) then
    raise exception using errcode = '22023', message = 'Conversation search is invalid';
  end if;

  return query
  select
    conversation.id,
    conversation.contact_id,
    -- An anonymous web visitor is shown as exactly that. No customer record is synthesised, and no
    -- link is offered, because there is no canonical identity to link to.
    case
      when contact.id is null then 'Anonymous visitor'
      else public.contact_display_name(contact.first_name, contact.last_name, contact.phone, contact.email)
    end,
    coalesce(channel.channel_type, 'web')::text,
    conversation.status,
    conversation.ai_mode,
    conversation.created_at,
    coalesce(conversation.last_message_at, conversation.created_at),
    coalesce(message_totals.total, 0)::integer,
    -- Reuses the Phase 13 resolver, which reads the preserved profile row, so a conversation once
    -- handled by a since-revoked teammate still renders their name.
    public.handoff_operator_display_name(conversation.assigned_user_id),
    active_handoff.status,
    active_handoff.urgency
  from public.conversations as conversation
  left join public.contacts as contact
    on contact.organization_id = conversation.organization_id
    and contact.id = conversation.contact_id
  left join public.channels as channel
    on channel.organization_id = conversation.organization_id
    and channel.id = conversation.channel_id
  left join lateral (
    select count(*) as total from public.messages as message
    where message.organization_id = conversation.organization_id
      and message.conversation_id = conversation.id
  ) as message_totals on true
  left join lateral (
    select handoff.status, handoff.urgency
    from public.handoffs as handoff
    where handoff.organization_id = conversation.organization_id
      and handoff.conversation_id = conversation.id
      and handoff.mode = 'customer'
      and handoff.status in ('open', 'acknowledged')
    order by handoff.created_at desc
    limit 1
  ) as active_handoff on true
  where conversation.organization_id = organization
    and conversation.location_id = target_location_id
    -- Test-agent conversations are not customer history.
    and conversation.mode = 'customer'
    and (target_channel is null or coalesce(channel.channel_type, 'web') = target_channel)
    and (target_status is null or conversation.status = target_status)
    -- Search matches the related customer, never message bodies: transcript search is not part of
    -- this phase and would need an index on customer content to work.
    and (
      normalized_search is null
      or contact.first_name ilike '%' || normalized_search || '%'
      or contact.last_name ilike '%' || normalized_search || '%'
      or contact.phone ilike '%' || normalized_search || '%'
      or contact.email ilike '%' || normalized_search || '%'
    )
    and (
      cursor_activity_at is null
      or (coalesce(conversation.last_message_at, conversation.created_at), conversation.id)
         < (cursor_activity_at, coalesce(cursor_conversation_id, '00000000-0000-0000-0000-000000000000'::uuid))
    )
  order by coalesce(conversation.last_message_at, conversation.created_at) desc, conversation.id desc
  limit bounded_limit;
end;
$$;

-- ============================================================================
-- 7. Conversation detail and transcript
-- ============================================================================

create function public.get_my_conversation_detail(
  target_location_id uuid,
  target_conversation_id uuid
)
returns table (
  conversation_id uuid,
  contact_id uuid,
  customer_display_name text,
  customer_phone text,
  customer_email text,
  channel text,
  status text,
  ai_mode text,
  created_at timestamptz,
  last_activity_at timestamptz,
  message_count integer,
  assigned_display_name text,
  active_handoff_id uuid,
  active_handoff_status text,
  active_handoff_urgency text,
  lead_id uuid,
  lead_status text,
  appointment_id uuid,
  appointment_title text,
  appointment_status text,
  appointment_starts_at timestamptz,
  call_id uuid,
  call_status text,
  call_started_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
declare
  organization uuid;
begin
  organization := public.my_customer_location_organization(target_location_id);
  if organization is null then
    return;
  end if;

  return query
  select
    conversation.id,
    conversation.contact_id,
    case
      when contact.id is null then 'Anonymous visitor'
      else public.contact_display_name(contact.first_name, contact.last_name, contact.phone, contact.email)
    end,
    contact.phone,
    contact.email,
    coalesce(channel.channel_type, 'web')::text,
    conversation.status,
    conversation.ai_mode,
    conversation.created_at,
    coalesce(conversation.last_message_at, conversation.created_at),
    coalesce(message_totals.total, 0)::integer,
    public.handoff_operator_display_name(conversation.assigned_user_id),
    active_handoff.id, active_handoff.status, active_handoff.urgency,
    related_lead.id, related_lead.status,
    related_appointment.id, related_appointment.title,
    related_appointment.status, related_appointment.starts_at,
    related_call.id, related_call.status, related_call.started_at
  from public.conversations as conversation
  left join public.contacts as contact
    on contact.organization_id = conversation.organization_id
    and contact.id = conversation.contact_id
  left join public.channels as channel
    on channel.organization_id = conversation.organization_id
    and channel.id = conversation.channel_id
  left join lateral (
    select count(*) as total from public.messages as message
    where message.organization_id = conversation.organization_id
      and message.conversation_id = conversation.id
  ) as message_totals on true
  left join lateral (
    select handoff.id, handoff.status, handoff.urgency
    from public.handoffs as handoff
    where handoff.organization_id = conversation.organization_id
      and handoff.conversation_id = conversation.id
      and handoff.mode = 'customer'
      and handoff.status in ('open', 'acknowledged')
    order by handoff.created_at desc limit 1
  ) as active_handoff on true
  -- Associated records through canonical foreign keys only. No provider lookup happens here.
  left join lateral (
    select lead.id, lead.status from public.leads as lead
    where lead.organization_id = conversation.organization_id
      and lead.conversation_id = conversation.id
    order by lead.created_at desc limit 1
  ) as related_lead on true
  left join lateral (
    select appointment.id, appointment.title, appointment.status, appointment.starts_at
    from public.appointments as appointment
    where appointment.organization_id = conversation.organization_id
      and appointment.conversation_id = conversation.id
    order by appointment.starts_at desc limit 1
  ) as related_appointment on true
  left join lateral (
    select call.id, call.status, call.started_at from public.calls as call
    where call.organization_id = conversation.organization_id
      and call.conversation_id = conversation.id
    order by call.started_at desc nulls last limit 1
  ) as related_call on true
  -- The URL identifier is not authority: the conversation has to belong to this authorized
  -- location and be production customer traffic, or nothing is returned at all.
  where conversation.organization_id = organization
    and conversation.location_id = target_location_id
    and conversation.id = target_conversation_id
    and conversation.mode = 'customer';
end;
$$;

create function public.get_my_conversation_transcript(
  target_location_id uuid,
  target_conversation_id uuid,
  cursor_created_at timestamptz default null,
  cursor_message_id uuid default null,
  page_limit integer default 50
)
returns table (
  message_id uuid,
  author_type text,
  direction text,
  source_channel text,
  message_type text,
  body text,
  created_at timestamptz,
  sent_at timestamptz,
  author_display_name text,
  in_reply_to_message_id uuid,
  delivery_status text,
  delivery_updated_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
declare
  organization uuid;
  bounded_limit integer := public.customer_history_page_limit(page_limit);
begin
  organization := public.my_customer_location_organization(target_location_id);
  if organization is null then
    return;
  end if;

  -- Conversation access is proved before a single message row is considered.
  if not exists (
    select 1 from public.conversations as conversation
    where conversation.organization_id = organization
      and conversation.location_id = target_location_id
      and conversation.id = target_conversation_id
      and conversation.mode = 'customer'
  ) then
    return;
  end if;

  return query
  select
    message.id,
    message.author_type,
    message.direction,
    message.source_channel,
    message.message_type,
    message.body,
    message.created_at,
    message.sent_at,
    -- Attribution comes from durable columns, never from reading the text. A human message sent by
    -- a since-revoked teammate still resolves, because the profile row is preserved.
    case
      when message.author_type = 'human' and message.sent_by_user_id is not null
        then public.handoff_operator_display_name(message.sent_by_user_id)
      else null
    end,
    message.in_reply_to_message_id,
    -- Durable provider truth, read and never rewritten. `unknown` stays unknown: Phase 7 made that
    -- state deliberately ambiguous so nobody resends a message the provider may have delivered.
    delivery.status,
    delivery.updated_at
  from public.messages as message
  left join lateral (
    select record.status, record.updated_at
    from public.message_deliveries as record
    where record.organization_id = message.organization_id
      and record.message_id = message.id
    order by record.updated_at desc
    limit 1
  ) as delivery on true
  where message.organization_id = organization
    and message.conversation_id = target_conversation_id
    -- Newest-first internally so a cursor walks backwards through history; the UI reverses each
    -- window so a page reads oldest to newest without reordering earlier pages.
    and (
      cursor_created_at is null
      or (message.created_at, message.id)
         < (cursor_created_at, coalesce(cursor_message_id, '00000000-0000-0000-0000-000000000000'::uuid))
    )
  order by message.created_at desc, message.id desc
  limit bounded_limit;
end;
$$;

-- ============================================================================
-- 8. Indexes
-- ============================================================================
--
-- Only what the read models above actually traverse, and only where an existing index does not
-- already serve the pattern. `messages_conversation_created_at_idx` already covers transcript
-- paging, and `handoffs_conversation_history_idx` already covers per-conversation handoff lookup,
-- so neither is duplicated here. Nothing indexes a message body or a metadata document: transcript
-- search is not part of this phase, and indexing customer content to support a feature nobody
-- asked for is how a search index becomes an exfiltration surface.

-- The archive orders by location and latest activity over production traffic only, which the
-- existing organization-wide index cannot serve.
create index conversations_location_activity_idx
  on public.conversations (location_id, last_message_at desc, id desc)
  where mode = 'customer';

-- Directory and timeline both walk a contact's conversations at one location.
create index conversations_location_contact_idx
  on public.conversations (location_id, contact_id)
  where mode = 'customer' and contact_id is not null;

-- Per-contact call history at a location. The existing voice index is location plus time only.
create index calls_location_contact_idx
  on public.calls (location_id, contact_id, started_at desc)
  where contact_id is not null;

-- The existing appointments index is location plus start time; the directory needs the contact.
create index appointments_location_contact_idx
  on public.appointments (location_id, contact_id, starts_at desc)
  where contact_id is not null;

-- The existing lead index is organization plus status; location and contact are what this reads.
create index leads_location_contact_idx
  on public.leads (location_id, contact_id, created_at desc)
  where contact_id is not null;

-- ============================================================================
-- 9. Direct contact mutation
-- ============================================================================
--
-- Every other operational table had its client mutation policies withdrawn as the phase that owned
-- it grew a real boundary: calls in Phase 4, appointments in Phase 5, messages and conversations in
-- Phase 7, leads in Phase 10, handoffs in Phase 13. `contacts` was simply never revisited.
--
-- The repository was checked before removing it. No browser code path in apps/web writes a contact,
-- and no API route does either; every contact row is created inside a SECURITY DEFINER function on
-- the voice, messaging, reminder, and handoff ingestion paths, which run as the definer and are
-- unaffected. Phase 16 is the phase that reads contacts, so it is the one that should close this.
--
-- Leaving it open would mean a customer identity used for SMS and voice routing could be rewritten
-- from a browser: a phone number changed under a conversation, or a name edited on a record another
-- location relies on.
revoke insert, update, delete on table public.contacts from authenticated, anon;

drop policy if exists contacts_insert_member on public.contacts;
drop policy if exists contacts_update_member on public.contacts;
drop policy if exists contacts_delete_admin on public.contacts;

-- SELECT stays: existing tenant-scoped reads legitimately join contacts, and the surviving policy
-- already restricts rows to locations the caller can access.

-- ============================================================================
-- 10. Function boundary
-- ============================================================================

-- Internal helpers are composed by the read models; none is a callable surface.
revoke all on function
  public.customer_history_page_limit(integer),
  public.contact_display_name(text, text, text, text),
  public.my_customer_location_organization(uuid),
  public.contact_has_location_activity(uuid, uuid, uuid),
  public.contact_visible_at_location(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- Customer history is an authenticated staff product view. Deliberately not service-role: these
-- derive the caller from auth.uid(), and a backend role standing in for a person would bypass the
-- location authorization that is the entire point.
revoke all on function
  public.get_my_customer_directory(uuid, text, timestamptz, uuid, integer),
  public.get_my_customer_overview(uuid, uuid),
  public.get_my_customer_timeline(uuid, uuid, timestamptz, text, uuid, integer),
  public.get_my_conversation_archive(uuid, text, text, text, timestamptz, uuid, integer),
  public.get_my_conversation_detail(uuid, uuid),
  public.get_my_conversation_transcript(uuid, uuid, timestamptz, uuid, integer)
  from public, anon, authenticated, service_role;

grant execute on function
  public.get_my_customer_directory(uuid, text, timestamptz, uuid, integer),
  public.get_my_customer_overview(uuid, uuid),
  public.get_my_customer_timeline(uuid, uuid, timestamptz, text, uuid, integer),
  public.get_my_conversation_archive(uuid, text, text, text, timestamptz, uuid, integer),
  public.get_my_conversation_detail(uuid, uuid),
  public.get_my_conversation_transcript(uuid, uuid, timestamptz, uuid, integer)
  to authenticated;

-- ============================================================================
-- 11. Schema compatibility
-- ============================================================================
--
-- Phase 16 code cannot work against a Phase 15 database: none of the read models above exist there.
update public.platform_schema_contract
set schema_version = 16, updated_at = now()
where id = true;
