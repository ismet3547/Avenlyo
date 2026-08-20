-- Phase 16 customer history hardening.  Additive follow-up to 20260829000000_phase_16_customer_history:
-- that migration is already reviewed and is not rewritten here.
--
-- Four defects, and they share a shape: the read models were correct about the rule they enforced,
-- but something outside them was not held to the same rule.
--
-- 1. Direct SELECT on public.contacts survived from Phase 0, authorized by contacts.location_id.
--    Phase 16 defines visibility as location access plus durable production activity, so the raw
--    table was a weaker door standing beside the strong one -- and it also returned metadata and
--    columns the read models deliberately omit.
--
-- 2. Phase 4 stores an inbound voice channel as channel_type = 'phone'. The archive compared the
--    filter value 'voice' against that column directly, so the voice filter matched nothing and a
--    real voice conversation was labelled Phone.
--
-- 3. Conversation detail authorized the parent conversation against the selected location but
--    resolved its associated lead, appointment, call, and handoff by conversation id alone.
--
-- 4. A partial pagination cursor was accepted, which silently changes what a page means.

-- ============================================================================
-- 1. History channel projection
-- ============================================================================
--
-- One normalization rule, defined once and used by every history surface, so the archive, its
-- filters, the detail page, and the timeline cannot drift into slightly different CASE expressions.
--
-- 'unknown' is the deliberate fail-safe. A conversation whose channel row is missing or holds a type
-- Phase 16 does not present is reported as unknown rather than assumed to be web chat: silently
-- declaring an unrecognised channel to be Web Chat is misclassifying customer history to make a
-- join look tidy. An unknown row still appears in the unfiltered archive -- it is real history --
-- but matches no channel filter, because it is not known to belong to one.
create function public.history_conversation_channel(channel_type text)
returns text language sql immutable set search_path = '' as $$
  select case channel_type
    -- Canonical inbound voice is stored as 'phone'; 'voice' is the word the product uses.
    when 'phone' then 'voice'
    when 'sms' then 'sms'
    when 'web' then 'web'
    else 'unknown'
  end;
$$;

-- Both halves of a keyset cursor have to arrive together. Half a cursor is not a smaller page: it
-- changes the comparison and can skip or repeat rows, so it is refused rather than guessed at.
create function public.require_complete_history_cursor(
  cursor_timestamp timestamptz,
  cursor_identifier uuid
)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if (cursor_timestamp is null) <> (cursor_identifier is null) then
    raise exception using errcode = '22023', message = 'History cursor is incomplete';
  end if;
end;
$$;

-- ============================================================================
-- 2. Conversation archive
-- ============================================================================
--
-- Body copied from 20260829000000_phase_16_customer_history.sql; the changes are the normalized
-- channel on both the projection and the filter, and the cursor completeness check.
create or replace function public.get_my_conversation_archive(
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

  perform public.require_complete_history_cursor(cursor_activity_at, cursor_conversation_id);

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
    public.history_conversation_channel(channel.channel_type),
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
    -- An unknown channel matches no filter, so it is never silently counted as web chat.
    and (
      target_channel is null
      or public.history_conversation_channel(channel.channel_type) = target_channel
    )
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
-- 3. Conversation detail
-- ============================================================================
--
-- Each associated record now carries its own location predicate. `appointments.location_id` is
-- NOT NULL so it compares directly; leads, calls, and handoffs allow null, so they use a null-safe
-- comparison rather than quietly dropping a legitimately location-less row.
create or replace function public.get_my_conversation_detail(
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
    public.history_conversation_channel(channel.channel_type),
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
      and handoff.location_id is not distinct from target_location_id
      and handoff.mode = 'customer'
      and handoff.status in ('open', 'acknowledged')
    order by handoff.created_at desc limit 1
  ) as active_handoff on true
  -- Associated records through canonical foreign keys only. No provider lookup happens here.
  left join lateral (
    select lead.id, lead.status from public.leads as lead
    where lead.organization_id = conversation.organization_id
      and lead.conversation_id = conversation.id
      and lead.location_id is not distinct from target_location_id
    order by lead.created_at desc limit 1
  ) as related_lead on true
  left join lateral (
    select appointment.id, appointment.title, appointment.status, appointment.starts_at
    from public.appointments as appointment
    where appointment.organization_id = conversation.organization_id
      and appointment.conversation_id = conversation.id
      and appointment.location_id = target_location_id
    order by appointment.starts_at desc limit 1
  ) as related_appointment on true
  left join lateral (
    select call.id, call.status, call.started_at from public.calls as call
    where call.organization_id = conversation.organization_id
      and call.conversation_id = conversation.id
      and call.location_id is not distinct from target_location_id
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

-- ============================================================================
-- 4. Customer timeline
-- ============================================================================
create or replace function public.get_my_customer_timeline(
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

  -- All three parts or none. A partial cursor changes the comparison and can skip or repeat an
  -- event at the same instant, which is exactly what the tie-breaker exists to prevent.
  if num_nulls(cursor_event_at, cursor_event_kind, cursor_event_id) not in (0, 3) then
    raise exception using errcode = '22023', message = 'History cursor is incomplete';
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
      public.history_conversation_channel(channel.channel_type) as channel,
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
-- 5. Customer directory
-- ============================================================================
create or replace function public.get_my_customer_directory(
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

  perform public.require_complete_history_cursor(cursor_last_activity_at, cursor_contact_id);

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
      select conversation.contact_id, min(conversation.created_at) as first_at,
        max(conversation.activity_at) as last_at,
        count(*)::integer as conversations, 0 as calls, 0 as appointments
      from production_conversations as conversation group by conversation.contact_id
      union all
      select call.contact_id, min(call.activity_at), max(call.activity_at), 0, count(*)::integer, 0
      from production_calls as call group by call.contact_id
      union all
      select appointment.contact_id, min(appointment.created_at), max(appointment.activity_at),
        0, 0, count(*)::integer
      from location_appointments as appointment group by appointment.contact_id
      union all
      select lead.contact_id, min(lead.created_at), max(lead.updated_at), 0, 0, 0
      from location_leads as lead group by lead.contact_id
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
    coalesce(preference.opted_out, false)
  from activity
  join public.contacts as contact
    on contact.organization_id = organization and contact.id = activity.contact_id
  left join latest_lead on latest_lead.contact_id = activity.contact_id
  left join lateral (
    select bool_or(preference.status = 'opted_out') as opted_out
    from public.messaging_contact_preferences as preference
    where preference.organization_id = organization
      and preference.location_id = target_location_id
      and preference.contact_id = activity.contact_id
      and preference.channel_type = 'sms'
  ) as preference on true
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
-- 6. Conversation transcript
-- ============================================================================
create or replace function public.get_my_conversation_transcript(
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

  perform public.require_complete_history_cursor(cursor_created_at, cursor_message_id);

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
-- 7. Direct contact reads
-- ============================================================================
--
-- Phase 16 defines customer visibility as location access plus durable production activity at that
-- location. The Phase 0 select policy authorized contacts by `contacts.location_id` alone, which is
-- a weaker rule sitting beside the stronger one: a browser could read a contact who has never
-- interacted with the location, and could read `metadata` and other raw columns the read models
-- deliberately omit.
--
-- The whole repository was audited before removing it. There is no direct table access anywhere in
-- apps/web or apps/api -- not to contacts, not to any table -- because every read already goes
-- through an RPC. The SECURITY DEFINER functions that join contacts run as the definer and are
-- unaffected, as are the ingestion paths that create contact rows.
revoke select on table public.contacts from authenticated, anon;

drop policy if exists contacts_select_member on public.contacts;

-- The Customer 360 read models are now the entire staff read surface for customer identity, and
-- their output columns are explicit.

-- ============================================================================
-- 8. Function boundary
-- ============================================================================

revoke all on function
  public.history_conversation_channel(text),
  public.require_complete_history_cursor(timestamptz, uuid)
  from public, anon, authenticated, service_role;

-- Replacing a function preserves its grants; these are restated so the boundary is visible here
-- rather than inferred from the previous migration.
revoke all on function
  public.get_my_customer_directory(uuid, text, timestamptz, uuid, integer),
  public.get_my_customer_timeline(uuid, uuid, timestamptz, text, uuid, integer),
  public.get_my_conversation_archive(uuid, text, text, text, timestamptz, uuid, integer),
  public.get_my_conversation_detail(uuid, uuid),
  public.get_my_conversation_transcript(uuid, uuid, timestamptz, uuid, integer)
  from public, anon, authenticated, service_role;

grant execute on function
  public.get_my_customer_directory(uuid, text, timestamptz, uuid, integer),
  public.get_my_customer_timeline(uuid, uuid, timestamptz, text, uuid, integer),
  public.get_my_conversation_archive(uuid, text, text, text, timestamptz, uuid, integer),
  public.get_my_conversation_detail(uuid, uuid),
  public.get_my_conversation_transcript(uuid, uuid, timestamptz, uuid, integer)
  to authenticated;

-- The schema compatibility version stays at 16: this corrects Phase 16 behaviour within the same
-- unmerged phase rather than adding a capability a Phase 16 build could not already assume.
