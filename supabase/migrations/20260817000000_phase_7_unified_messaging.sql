-- Phase 7: unified text messaging runtime.  All customer ingress and staff actions use
-- security-definer RPCs; browser clients never write the internal messaging tables directly.

alter table public.conversations
  add column ai_mode text not null default 'ai'
    check (ai_mode in ('ai', 'human')),
  add column transport_phone_number_id uuid,
  add constraint conversations_transport_phone_number_fk
    foreign key (organization_id, transport_phone_number_id)
    references public.phone_numbers (organization_id, id);

alter table public.messages
  add column source_channel text not null default 'voice'
    check (source_channel in ('voice', 'sms', 'web', 'internal')),
  add column author_type text not null default 'system'
    check (author_type in ('customer', 'ai', 'human', 'system')),
  add column sent_by_user_id uuid,
  add column in_reply_to_message_id uuid,
  add column client_message_id uuid,
  add constraint messages_sent_by_member_fk
    foreign key (organization_id, sent_by_user_id)
    references public.organization_members (organization_id, user_id),
  add constraint messages_reply_scope_fk
    foreign key (organization_id, in_reply_to_message_id)
    references public.messages (organization_id, id),
  add constraint messages_body_length_check
    check (body is null or char_length(body) <= 2000);

alter table public.phone_numbers
  add column sms_enabled boolean not null default false;

create unique index conversations_open_sms_transport_key
  on public.conversations (organization_id, location_id, contact_id, channel_id, transport_phone_number_id)
  where status = 'open' and transport_phone_number_id is not null;
create unique index messages_ai_reply_per_inbound_key
  on public.messages (in_reply_to_message_id)
  where author_type = 'ai' and in_reply_to_message_id is not null;
create unique index messages_client_id_per_conversation_key
  on public.messages (conversation_id, client_message_id)
  where client_message_id is not null;

create table public.message_processing_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  conversation_id uuid not null,
  message_id uuid not null,
  job_kind text not null check (job_kind in ('inbound_ai', 'outbound_delivery')),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 12),
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_processing_jobs_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint message_processing_jobs_conversation_fk foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade,
  constraint message_processing_jobs_message_fk foreign key (organization_id, message_id)
    references public.messages (organization_id, id) on delete cascade,
  constraint message_processing_jobs_organization_id_id_key unique (organization_id, id),
  constraint message_processing_jobs_message_kind_key unique (message_id, job_kind)
);
create index message_processing_jobs_claim_idx
  on public.message_processing_jobs (status, available_at, created_at)
  where status in ('queued', 'processing');

create table public.message_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid,
  message_id uuid not null,
  provider text not null check (provider in ('twilio', 'web_chat')),
  provider_message_id text,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered', 'unknown')),
  status_rank integer not null default 0 check (status_rank between 0 and 6),
  error_code text,
  attempted_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_deliveries_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint message_deliveries_message_fk foreign key (organization_id, message_id)
    references public.messages (organization_id, id) on delete cascade,
  constraint message_deliveries_organization_id_id_key unique (organization_id, id),
  constraint message_deliveries_message_provider_key unique (message_id, provider),
  constraint message_deliveries_provider_message_key unique (provider, provider_message_id)
);

create table public.messaging_contact_preferences (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  contact_id uuid not null,
  channel_type text not null check (channel_type in ('sms', 'web')),
  status text not null default 'active' check (status in ('active', 'opted_out')),
  opted_out_at timestamptz,
  source_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint messaging_contact_preferences_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade,
  constraint messaging_contact_preferences_source_message_fk foreign key (organization_id, source_message_id)
    references public.messages (organization_id, id),
  constraint messaging_contact_preferences_organization_id_id_key unique (organization_id, id),
  constraint messaging_contact_preferences_contact_channel_key unique (contact_id, channel_type)
);

create table public.web_chat_widgets (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  channel_id uuid not null,
  public_key uuid not null default extensions.gen_random_uuid(),
  enabled boolean not null default false,
  allowed_origins jsonb not null default '[]'::jsonb,
  welcome_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint web_chat_widgets_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint web_chat_widgets_channel_fk foreign key (organization_id, channel_id)
    references public.channels (organization_id, id),
  constraint web_chat_widgets_organization_id_id_key unique (organization_id, id),
  constraint web_chat_widgets_public_key_key unique (public_key),
  constraint web_chat_widgets_location_key unique (organization_id, location_id),
  constraint web_chat_widgets_origins_array_check check (jsonb_typeof(allowed_origins) = 'array'),
  constraint web_chat_widgets_welcome_length_check check (welcome_message is null or char_length(welcome_message) <= 500)
);

create table public.web_chat_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  location_id uuid not null,
  widget_id uuid not null,
  conversation_id uuid not null,
  contact_id uuid,
  token_hash text not null,
  origin text not null,
  expires_at timestamptz not null,
  last_active_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint web_chat_sessions_location_fk foreign key (organization_id, location_id)
    references public.locations (organization_id, id),
  constraint web_chat_sessions_widget_fk foreign key (organization_id, widget_id)
    references public.web_chat_widgets (organization_id, id) on delete cascade,
  constraint web_chat_sessions_conversation_fk foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade,
  constraint web_chat_sessions_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id),
  constraint web_chat_sessions_organization_id_id_key unique (organization_id, id),
  constraint web_chat_sessions_token_hash_key unique (token_hash),
  constraint web_chat_sessions_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$')
);
create index web_chat_sessions_active_idx on public.web_chat_sessions (token_hash, expires_at);

create table public.messaging_rate_limits (
  scope_key text primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0),
  updated_at timestamptz not null default now()
);

create trigger set_message_processing_jobs_updated_at before update on public.message_processing_jobs
  for each row execute procedure public.set_updated_at();
create trigger set_message_deliveries_updated_at before update on public.message_deliveries
  for each row execute procedure public.set_updated_at();
create trigger set_messaging_contact_preferences_updated_at before update on public.messaging_contact_preferences
  for each row execute procedure public.set_updated_at();
create trigger set_web_chat_widgets_updated_at before update on public.web_chat_widgets
  for each row execute procedure public.set_updated_at();
create trigger set_web_chat_sessions_updated_at before update on public.web_chat_sessions
  for each row execute procedure public.set_updated_at();

create function public.require_messaging_service_role()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Trusted messaging backend access is required';
  end if;
end;
$$;

create function public.normalized_web_chat_origin(target_origin text)
returns text language plpgsql immutable set search_path = '' as $$
declare normalized text := lower(regexp_replace(btrim(coalesce(target_origin, '')), '/+$', ''));
begin
  if normalized ~ '^https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$'
    or normalized ~ '^http://localhost(?::[0-9]{1,5})?$' then
    return normalized;
  end if;
  raise exception using errcode = '22023', message = 'Web chat origin is invalid';
end;
$$;

create function public.consume_messaging_rate_limit(
  target_scope_key text,
  target_limit integer,
  target_window_seconds integer
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare current_count integer; current_window timestamptz;
begin
  if length(target_scope_key) not between 8 and 500 or target_limit not between 1 and 1000
    or target_window_seconds not between 1 and 86400 then
    raise exception using errcode = '22023', message = 'Messaging rate limit input is invalid';
  end if;
  insert into public.messaging_rate_limits (scope_key, window_started_at, request_count)
  values (target_scope_key, now(), 1)
  on conflict (scope_key) do update
    set window_started_at = case
          when public.messaging_rate_limits.window_started_at <= now() - make_interval(secs => target_window_seconds)
          then now() else public.messaging_rate_limits.window_started_at end,
        request_count = case
          when public.messaging_rate_limits.window_started_at <= now() - make_interval(secs => target_window_seconds)
          then 1 else public.messaging_rate_limits.request_count + 1 end,
        updated_at = now()
  returning request_count, window_started_at into current_count, current_window;
  return current_count <= target_limit and current_window > now() - make_interval(secs => target_window_seconds);
end;
$$;

create function public.is_explicit_booking_confirmation(target_body text)
returns boolean language sql immutable set search_path = '' as $$
  select lower(regexp_replace(btrim(coalesce(target_body, '')), '\s+', ' ', 'g')) in (
    'yes', 'yes please', 'yes, please', 'yes, please book it.', 'yes, please book that appointment.',
    'yes please book it', 'yes please book that appointment', 'confirm', 'confirmed', 'i confirm',
    'that works', 'that works for me', 'book it', 'please book it', 'sounds good'
  );
$$;

-- Trusted inbound SMS persistence: routing is by the configured Avenlyo DID, not a model-supplied value.
create function public.bootstrap_inbound_sms(
  target_message_sid text,
  target_from_e164 text,
  target_to_e164 text,
  target_body text,
  target_media jsonb default '[]'::jsonb,
  target_provider_metadata jsonb default '{}'::jsonb
)
returns table (
  accepted boolean,
  is_duplicate boolean,
  message_id uuid,
  conversation_id uuid,
  organization_id uuid,
  location_id uuid,
  command text
)
language plpgsql security definer set search_path = '' as $$
declare route public.phone_numbers%rowtype; channel_row public.channels%rowtype; contact_row public.contacts%rowtype;
declare conversation_row public.conversations%rowtype; saved_message_id uuid; normalized_body text; detected_command text := null;
begin
  perform public.require_messaging_service_role();
  if target_message_sid !~ '^SM[a-zA-Z0-9]{32}$' or target_from_e164 !~ '^\\+[1-9][0-9]{7,14}$'
    or target_to_e164 !~ '^\\+[1-9][0-9]{7,14}$' or char_length(coalesce(target_body, '')) > 2000
    or jsonb_typeof(target_media) <> 'array' then
    raise exception using errcode = '22023', message = 'Inbound SMS payload is invalid';
  end if;
  select * into route from public.phone_numbers
    where phone_number = target_to_e164 and status = 'active' and sms_enabled;
  if route.id is null then
    return query select false, false, null::uuid, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;
  if not public.consume_messaging_rate_limit('sms:' || route.id::text || ':' || target_from_e164, 30, 60) then
    return query select true, false, null::uuid, null::uuid, route.organization_id, route.location_id, 'rate_limited'::text;
    return;
  end if;
  normalized_body := lower(regexp_replace(btrim(coalesce(target_body, '')), '\s+', ' ', 'g'));
  if normalized_body in ('stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit') then detected_command := 'stop';
  elsif normalized_body in ('start', 'unstop', 'yes') then detected_command := 'start';
  elsif normalized_body = 'help' then detected_command := 'help'; end if;
  select * into channel_row from public.channels
    where organization_id = route.organization_id and location_id = route.location_id
      and channel_type = 'sms' and status = 'active'
    order by created_at asc limit 1;
  if channel_row.id is null then
    insert into public.channels (organization_id, location_id, channel_type, display_name, status, configuration)
    values (route.organization_id, route.location_id, 'sms', 'SMS', 'active', jsonb_build_object('phone_number_id', route.id))
    returning * into channel_row;
  end if;
  select * into contact_row from public.contacts
    where organization_id = route.organization_id and phone = target_from_e164
    order by (location_id = route.location_id) desc, created_at asc limit 1;
  if contact_row.id is null then
    insert into public.contacts (organization_id, location_id, phone, metadata)
    values (route.organization_id, route.location_id, target_from_e164, jsonb_build_object('source', 'sms'))
    returning * into contact_row;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sms-conversation:' || route.id::text || ':' || contact_row.id::text, 0));
  select * into conversation_row from public.conversations
    where organization_id = route.organization_id and location_id = route.location_id
      and contact_id = contact_row.id and channel_id = channel_row.id and transport_phone_number_id = route.id
      and status = 'open' order by updated_at desc limit 1;
  if conversation_row.id is null then
    insert into public.conversations (organization_id, location_id, contact_id, channel_id, transport_phone_number_id, status, metadata)
    values (route.organization_id, route.location_id, contact_row.id, channel_row.id, route.id, 'open', jsonb_build_object('transport', 'sms'))
    returning * into conversation_row;
  end if;
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, external_id, metadata, source_channel, author_type, sent_at)
  values (route.organization_id, route.location_id, conversation_row.id, contact_row.id, 'inbound',
    case when jsonb_array_length(target_media) > 0 and length(btrim(coalesce(target_body, ''))) = 0 then 'media' else 'text' end,
    nullif(btrim(target_body), ''), target_message_sid,
    jsonb_build_object('provider', 'twilio', 'media', target_media, 'provider_metadata', target_provider_metadata), 'sms', 'customer', now())
  on conflict (organization_id, external_id) do nothing returning id into saved_message_id;
  if saved_message_id is null then
    select id into saved_message_id from public.messages where organization_id = route.organization_id and external_id = target_message_sid;
    return query select true, true, saved_message_id, conversation_row.id, route.organization_id, route.location_id, detected_command;
    return;
  end if;
  insert into public.messaging_contact_preferences (organization_id, contact_id, channel_type, status, opted_out_at, source_message_id)
  values (route.organization_id, contact_row.id, 'sms', case when detected_command = 'stop' then 'opted_out' else 'active' end,
    case when detected_command = 'stop' then now() else null end, saved_message_id)
  on conflict (contact_id, channel_type) do update set
    status = case when detected_command = 'stop' then 'opted_out' when detected_command = 'start' then 'active' else public.messaging_contact_preferences.status end,
    opted_out_at = case when detected_command = 'stop' then now() when detected_command = 'start' then null else public.messaging_contact_preferences.opted_out_at end,
    source_message_id = excluded.source_message_id,
    updated_at = now();
  insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind)
  values (route.organization_id, route.location_id, conversation_row.id, saved_message_id, 'inbound_ai') on conflict do nothing;
  update public.conversations set last_message_at = now(), updated_at = now()
    where organization_id = route.organization_id and id = conversation_row.id;
  return query select true, false, saved_message_id, conversation_row.id, route.organization_id, route.location_id, detected_command;
end;
$$;

create function public.create_web_chat_session(
  target_widget_public_key uuid,
  target_origin text,
  target_token_hash text,
  target_rate_scope text
)
returns table (session_id uuid, conversation_id uuid, welcome_message text)
language plpgsql security definer set search_path = '' as $$
declare widget public.web_chat_widgets%rowtype; normalized_origin text; channel_row public.channels%rowtype; session_row public.web_chat_sessions%rowtype;
begin
  if target_token_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode = '22023', message = 'Web chat session is invalid'; end if;
  normalized_origin := public.normalized_web_chat_origin(target_origin);
  if not public.consume_messaging_rate_limit('web-session:' || target_rate_scope, 10, 60) then
    raise exception using errcode = '42901', message = 'Too many web chat session requests';
  end if;
  select * into widget from public.web_chat_widgets
    where public_key = target_widget_public_key and enabled;
  if widget.id is null or not exists (
    select 1 from jsonb_array_elements_text(widget.allowed_origins) as allowed(origin)
      where public.normalized_web_chat_origin(allowed.origin) = normalized_origin
  ) then raise exception using errcode = '42501', message = 'Web chat widget is not available for this origin'; end if;
  select * into channel_row from public.channels where organization_id = widget.organization_id and id = widget.channel_id and channel_type = 'web' and status = 'active';
  if channel_row.id is null then raise exception using errcode = '42501', message = 'Web chat channel is not available'; end if;
  insert into public.conversations (organization_id, location_id, channel_id, status, metadata)
  values (widget.organization_id, widget.location_id, widget.channel_id, 'open', jsonb_build_object('transport', 'web_chat'))
  returning id into session_row.conversation_id;
  insert into public.web_chat_sessions (organization_id, location_id, widget_id, conversation_id, token_hash, origin, expires_at)
  values (widget.organization_id, widget.location_id, widget.id, session_row.conversation_id, target_token_hash, normalized_origin, now() + interval '24 hours')
  returning * into session_row;
  return query select session_row.id, session_row.conversation_id, widget.welcome_message;
end;
$$;

create function public.append_web_chat_message(
  target_token_hash text,
  target_origin text,
  target_client_message_id uuid,
  target_body text,
  target_rate_scope text
)
returns table (message_id uuid, conversation_id uuid, is_duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare session_row public.web_chat_sessions%rowtype; saved_message_id uuid; normalized_origin text;
begin
  if target_token_hash !~ '^[0-9a-f]{64}$' or target_client_message_id is null
    or length(btrim(coalesce(target_body, ''))) not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Web chat message is invalid'; end if;
  normalized_origin := public.normalized_web_chat_origin(target_origin);
  if not public.consume_messaging_rate_limit('web-message:' || target_rate_scope, 30, 60) then
    raise exception using errcode = '42901', message = 'Too many web chat messages'; end if;
  select * into session_row from public.web_chat_sessions
    where token_hash = target_token_hash and origin = normalized_origin and expires_at > now() for update;
  if session_row.id is null then raise exception using errcode = '42501', message = 'Web chat session is unavailable'; end if;
  select id into saved_message_id from public.messages
    where organization_id = session_row.organization_id and conversation_id = session_row.conversation_id and client_message_id = target_client_message_id;
  if saved_message_id is not null then return query select saved_message_id, session_row.conversation_id, true; return; end if;
  insert into public.messages (organization_id, location_id, conversation_id, direction, message_type, body, metadata, source_channel, author_type, client_message_id, sent_at)
  values (session_row.organization_id, session_row.location_id, session_row.conversation_id, 'inbound', 'text', btrim(target_body),
    jsonb_build_object('transport', 'web_chat'), 'web', 'customer', target_client_message_id, now()) returning id into saved_message_id;
  insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind)
  values (session_row.organization_id, session_row.location_id, session_row.conversation_id, saved_message_id, 'inbound_ai');
  update public.web_chat_sessions set last_active_at = now(), expires_at = now() + interval '24 hours', updated_at = now()
    where id = session_row.id;
  update public.conversations set last_message_at = now(), updated_at = now() where id = session_row.conversation_id;
  return query select saved_message_id, session_row.conversation_id, false;
end;
$$;

create function public.get_web_chat_messages(target_token_hash text, target_origin text, target_after timestamptz default null)
returns table (message_id uuid, direction text, author_type text, body text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare session_row public.web_chat_sessions%rowtype; normalized_origin text;
begin
  normalized_origin := public.normalized_web_chat_origin(target_origin);
  select * into session_row from public.web_chat_sessions
    where token_hash = target_token_hash and origin = normalized_origin and expires_at > now();
  if session_row.id is null then raise exception using errcode = '42501', message = 'Web chat session is unavailable'; end if;
  update public.web_chat_sessions set last_active_at = now(), expires_at = now() + interval '24 hours', updated_at = now() where id = session_row.id;
  return query select message.id, message.direction, message.author_type, message.body, message.created_at
    from public.messages message
    where message.organization_id = session_row.organization_id and message.conversation_id = session_row.conversation_id
      and (target_after is null or message.created_at > target_after)
    order by message.created_at asc, message.id asc limit 100;
end;
$$;

create function public.get_my_inbox_conversations(target_location_id uuid default null)
returns table (conversation_id uuid, location_id uuid, channel_type text, contact_name text, contact_phone text, latest_body text, latest_at timestamptz, ai_mode text, handoff_open boolean)
language sql stable security definer set search_path = '' as $$
  select conversation.id, conversation.location_id, channel.channel_type,
    nullif(btrim(concat_ws(' ', contact.first_name, contact.last_name)), ''), contact.phone,
    latest.body, coalesce(latest.created_at, conversation.last_message_at, conversation.created_at), conversation.ai_mode,
    exists(select 1 from public.handoffs handoff where handoff.organization_id = conversation.organization_id and handoff.conversation_id = conversation.id and handoff.status in ('open','acknowledged'))
  from public.conversations conversation
  join public.channels channel on channel.organization_id = conversation.organization_id and channel.id = conversation.channel_id
  left join public.contacts contact on contact.organization_id = conversation.organization_id and contact.id = conversation.contact_id
  left join lateral (select body, created_at from public.messages where organization_id = conversation.organization_id and conversation_id = conversation.id order by created_at desc limit 1) latest on true
  where public.has_location_access(conversation.organization_id, conversation.location_id)
    and (target_location_id is null or conversation.location_id = target_location_id)
  order by coalesce(latest.created_at, conversation.last_message_at, conversation.created_at) desc;
$$;

create function public.get_my_inbox_messages(target_conversation_id uuid)
returns table (message_id uuid, direction text, author_type text, body text, source_channel text, delivery_status text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select message.id, message.direction, message.author_type, message.body, message.source_channel, delivery.status, message.created_at
  from public.messages message
  join public.conversations conversation on conversation.organization_id = message.organization_id and conversation.id = message.conversation_id
  left join public.message_deliveries delivery on delivery.organization_id = message.organization_id and delivery.message_id = message.id
  where message.id is not null and message.conversation_id = target_conversation_id
    and public.has_location_access(conversation.organization_id, conversation.location_id)
  order by message.created_at asc, message.id asc;
$$;

create function public.take_over_my_conversation(target_conversation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare conversation_row public.conversations%rowtype;
begin
  select * into conversation_row from public.conversations where id = target_conversation_id;
  if conversation_row.id is null or not public.has_location_write_access(conversation_row.organization_id, conversation_row.location_id) then
    raise exception using errcode = '42501', message = 'Conversation is not available'; end if;
  update public.conversations set ai_mode = 'human', assigned_user_id = auth.uid(), updated_at = now()
    where organization_id = conversation_row.organization_id and id = conversation_row.id;
end;
$$;

create function public.resume_my_conversation_ai(target_conversation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare conversation_row public.conversations%rowtype;
begin
  select * into conversation_row from public.conversations where id = target_conversation_id;
  if conversation_row.id is null or not public.has_location_write_access(conversation_row.organization_id, conversation_row.location_id) then
    raise exception using errcode = '42501', message = 'Conversation is not available'; end if;
  update public.conversations set ai_mode = 'ai', assigned_user_id = null, updated_at = now()
    where organization_id = conversation_row.organization_id and id = conversation_row.id;
end;
$$;

create function public.create_my_human_reply(target_conversation_id uuid, target_body text)
returns table (message_id uuid, source_channel text)
language plpgsql security definer set search_path = '' as $$
declare conversation_row public.conversations%rowtype; channel_row public.channels%rowtype; saved_message_id uuid; contact_opted_out boolean;
begin
  if length(btrim(coalesce(target_body, ''))) not between 1 and 2000 then raise exception using errcode = '22023', message = 'Reply is invalid'; end if;
  select * into conversation_row from public.conversations where id = target_conversation_id;
  if conversation_row.id is null or not public.has_location_write_access(conversation_row.organization_id, conversation_row.location_id) then raise exception using errcode = '42501', message = 'Conversation is not available'; end if;
  select * into channel_row from public.channels where organization_id = conversation_row.organization_id and id = conversation_row.channel_id;
  select exists(select 1 from public.messaging_contact_preferences preference where preference.organization_id = conversation_row.organization_id and preference.contact_id = conversation_row.contact_id and preference.channel_type = 'sms' and preference.status = 'opted_out') into contact_opted_out;
  if channel_row.channel_type = 'sms' and contact_opted_out then raise exception using errcode = '42501', message = 'SMS contact has opted out'; end if;
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, sent_by_user_id, sent_at)
  values (conversation_row.organization_id, conversation_row.location_id, conversation_row.id, conversation_row.contact_id, 'outbound', 'text', btrim(target_body), jsonb_build_object('transport', channel_row.channel_type), case when channel_row.channel_type = 'sms' then 'sms' else 'web' end, 'human', auth.uid(), now())
  returning id into saved_message_id;
  if channel_row.channel_type = 'sms' then
    insert into public.message_deliveries (organization_id, location_id, message_id, provider) values (conversation_row.organization_id, conversation_row.location_id, saved_message_id, 'twilio');
    insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind) values (conversation_row.organization_id, conversation_row.location_id, conversation_row.id, saved_message_id, 'outbound_delivery');
  else
    insert into public.message_deliveries (organization_id, location_id, message_id, provider, status, status_rank, sent_at) values (conversation_row.organization_id, conversation_row.location_id, saved_message_id, 'web_chat', 'sent', 2, now());
  end if;
  update public.conversations set ai_mode = 'human', assigned_user_id = auth.uid(), last_message_at = now(), updated_at = now() where id = conversation_row.id;
  return query select saved_message_id, case when channel_row.channel_type = 'sms' then 'sms' else 'web' end;
end;
$$;

create function public.get_my_web_chat_widget(target_location_id uuid)
returns table (widget_id uuid, public_key uuid, enabled boolean, allowed_origins jsonb, welcome_message text)
language plpgsql stable security definer set search_path = '' as $$
declare workspace record;
begin
  select location.organization_id, location.id into workspace from public.locations location where location.id = target_location_id;
  if workspace.organization_id is null or not public.is_organization_admin(workspace.organization_id) then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  return query select widget.id, widget.public_key, widget.enabled, widget.allowed_origins, widget.welcome_message
    from public.web_chat_widgets widget where widget.organization_id = workspace.organization_id and widget.location_id = target_location_id;
end;
$$;

create function public.upsert_my_web_chat_widget(
  target_location_id uuid,
  target_enabled boolean,
  target_allowed_origins jsonb,
  target_welcome_message text default null
)
returns table (widget_id uuid, public_key uuid, enabled boolean, allowed_origins jsonb, welcome_message text)
language plpgsql security definer set search_path = '' as $$
declare workspace record; channel_row public.channels%rowtype; canonical_origins jsonb; saved public.web_chat_widgets%rowtype;
begin
  if jsonb_typeof(target_allowed_origins) <> 'array' or jsonb_array_length(target_allowed_origins) > 20 or char_length(coalesce(target_welcome_message, '')) > 500 then raise exception using errcode = '22023', message = 'Web chat widget configuration is invalid'; end if;
  select location.organization_id, location.id into workspace from public.locations location where location.id = target_location_id;
  if workspace.organization_id is null or not public.is_organization_admin(workspace.organization_id) then raise exception using errcode = '42501', message = 'Organization owner or admin access is required'; end if;
  select coalesce(jsonb_agg(origin order by origin), '[]'::jsonb) into canonical_origins from (
    select distinct public.normalized_web_chat_origin(value) as origin from jsonb_array_elements_text(target_allowed_origins) value
  ) normalized;
  if jsonb_array_length(canonical_origins) <> jsonb_array_length(target_allowed_origins) then raise exception using errcode = '22023', message = 'Web chat origins must be unique'; end if;
  select * into channel_row from public.channels where organization_id = workspace.organization_id and location_id = target_location_id and channel_type = 'web' order by created_at asc limit 1;
  if channel_row.id is null then insert into public.channels (organization_id, location_id, channel_type, display_name, status) values (workspace.organization_id, target_location_id, 'web', 'Website chat', 'active') returning * into channel_row; end if;
  insert into public.web_chat_widgets (organization_id, location_id, channel_id, enabled, allowed_origins, welcome_message)
  values (workspace.organization_id, target_location_id, channel_row.id, target_enabled, canonical_origins, nullif(btrim(target_welcome_message), ''))
  on conflict (organization_id, location_id) do update set channel_id = excluded.channel_id, enabled = excluded.enabled, allowed_origins = excluded.allowed_origins, welcome_message = excluded.welcome_message, updated_at = now()
  returning * into saved;
  return query select saved.id, saved.public_key, saved.enabled, saved.allowed_origins, saved.welcome_message;
end;
$$;

create function public.claim_message_processing_jobs(target_worker_id text, target_limit integer default 5)
returns table (job_id uuid, job_kind text, message_id uuid, conversation_id uuid, organization_id uuid, location_id uuid, attempts integer)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_worker_id, ''))) not between 3 and 160 or target_limit not between 1 and 20 then raise exception using errcode = '22023', message = 'Worker claim is invalid'; end if;
  update public.message_processing_jobs set status = 'queued', claimed_at = null, claimed_by = null, available_at = now(), updated_at = now()
    where status = 'processing' and claimed_at < now() - interval '5 minutes';
  return query
  with claimed as (
    select id from public.message_processing_jobs
      where status = 'queued' and available_at <= now()
      order by created_at asc
      for update skip locked limit target_limit
  ), updated as (
    update public.message_processing_jobs job set status = 'processing', attempts = attempts + 1, claimed_at = now(), claimed_by = btrim(target_worker_id), updated_at = now()
      from claimed where job.id = claimed.id
      returning job.*
  ) select id, job_kind, message_id, conversation_id, organization_id, location_id, attempts from updated;
end;
$$;

create function public.complete_message_processing_job(target_job_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin perform public.require_messaging_service_role(); update public.message_processing_jobs set status = 'completed', completed_at = now(), claimed_at = null, claimed_by = null, updated_at = now() where id = target_job_id and status = 'processing'; end;
$$;

create function public.retry_message_processing_job(target_job_id uuid, target_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  update public.message_processing_jobs set status = case when attempts >= 8 then 'failed' else 'queued' end,
    available_at = now() + make_interval(secs => least(300, 5 * (2 ^ least(attempts, 6))::integer)), claimed_at = null, claimed_by = null,
    last_error_code = left(nullif(btrim(target_error_code), ''), 120), updated_at = now() where id = target_job_id and status = 'processing';
end;
$$;

create function public.get_message_runtime_context(target_message_id uuid)
returns table (message_id uuid, conversation_id uuid, organization_id uuid, location_id uuid, channel_type text, ai_mode text, body text, contact_id uuid, contact_phone text, transport_phone_number_id uuid, inbound_message_id uuid)
language sql stable security definer set search_path = '' as $$
  select message.id, conversation.id, conversation.organization_id, conversation.location_id, channel.channel_type, conversation.ai_mode,
    message.body, conversation.contact_id, contact.phone, conversation.transport_phone_number_id, message.id
  from public.messages message join public.conversations conversation on conversation.organization_id = message.organization_id and conversation.id = message.conversation_id
  join public.channels channel on channel.organization_id = conversation.organization_id and channel.id = conversation.channel_id
  left join public.contacts contact on contact.organization_id = conversation.organization_id and contact.id = conversation.contact_id
  where message.id = target_message_id and message.direction = 'inbound';
$$;

create function public.persist_ai_message_reply(target_inbound_message_id uuid, target_body text, target_handoff_requested boolean default false)
returns table (message_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare inbound public.messages%rowtype; conversation_row public.conversations%rowtype; channel_row public.channels%rowtype; saved_message_id uuid; opted_out boolean;
begin
  perform public.require_messaging_service_role();
  if length(btrim(coalesce(target_body, ''))) not between 1 and 2000 then raise exception using errcode = '22023', message = 'Assistant reply is invalid'; end if;
  select * into inbound from public.messages where id = target_inbound_message_id and direction = 'inbound';
  if inbound.id is null then raise exception using errcode = '42501', message = 'Inbound message is unavailable'; end if;
  select * into conversation_row from public.conversations where organization_id = inbound.organization_id and id = inbound.conversation_id for update;
  if conversation_row.ai_mode <> 'ai' then return query select null::uuid, false; return; end if;
  select * into channel_row from public.channels where organization_id = conversation_row.organization_id and id = conversation_row.channel_id;
  select exists(select 1 from public.messaging_contact_preferences preference where preference.organization_id = conversation_row.organization_id and preference.contact_id = conversation_row.contact_id and preference.channel_type = 'sms' and preference.status = 'opted_out') into opted_out;
  if channel_row.channel_type = 'sms' and opted_out then return query select null::uuid, false; return; end if;
  insert into public.messages (organization_id, location_id, conversation_id, contact_id, direction, message_type, body, metadata, source_channel, author_type, in_reply_to_message_id, sent_at)
  values (inbound.organization_id, inbound.location_id, inbound.conversation_id, inbound.contact_id, 'outbound', 'text', btrim(target_body),
    jsonb_build_object('transport', channel_row.channel_type), case when channel_row.channel_type = 'sms' then 'sms' else 'web' end, 'ai', inbound.id, now())
  on conflict (in_reply_to_message_id) where author_type = 'ai' and in_reply_to_message_id is not null do nothing returning id into saved_message_id;
  if saved_message_id is null then select id into saved_message_id from public.messages where in_reply_to_message_id = inbound.id and author_type = 'ai'; return query select saved_message_id, false; return; end if;
  if channel_row.channel_type = 'sms' then
    insert into public.message_deliveries (organization_id, location_id, message_id, provider) values (inbound.organization_id, inbound.location_id, saved_message_id, 'twilio');
    insert into public.message_processing_jobs (organization_id, location_id, conversation_id, message_id, job_kind) values (inbound.organization_id, inbound.location_id, inbound.conversation_id, saved_message_id, 'outbound_delivery');
  else
    insert into public.message_deliveries (organization_id, location_id, message_id, provider, status, status_rank, sent_at) values (inbound.organization_id, inbound.location_id, saved_message_id, 'web_chat', 'sent', 2, now());
  end if;
  if target_handoff_requested then update public.conversations set ai_mode = 'human', updated_at = now() where id = conversation_row.id; end if;
  update public.conversations set last_message_at = now(), updated_at = now() where id = conversation_row.id;
  return query select saved_message_id, true;
end;
$$;

create function public.get_message_agent_context(target_message_id uuid)
returns table (message_id uuid, conversation_id uuid, organization_id uuid, location_id uuid, industry_id text, organization_name text, location_name text, location_timezone text, location_address jsonb, business_hours jsonb, business_phone text, website_url text, history jsonb)
language sql stable security definer set search_path = '' as $$
  select message.id, conversation.id, conversation.organization_id, conversation.location_id,
    organization.primary_industry_id, organization.name, location.name, location.timezone, location.address,
    location.business_hours, organization.business_phone, organization.website_url,
    coalesce((select jsonb_agg(jsonb_build_object('author_type', historic.author_type, 'body', historic.body) order by historic.created_at asc)
      from (select author_type, body, created_at from public.messages
        where organization_id = conversation.organization_id and conversation_id = conversation.id and body is not null
        order by created_at desc limit 16) historic), '[]'::jsonb)
  from public.messages message
  join public.conversations conversation on conversation.organization_id = message.organization_id and conversation.id = message.conversation_id
  join public.organizations organization on organization.id = conversation.organization_id
  join public.locations location on location.organization_id = conversation.organization_id and location.id = conversation.location_id
  where message.id = target_message_id and message.direction = 'inbound' and message.author_type = 'customer';
$$;

create function public.has_persisted_ai_reply(target_inbound_message_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  return exists(select 1 from public.messages where in_reply_to_message_id = target_inbound_message_id and author_type = 'ai');
end;
$$;

create function public.request_message_handoff(
  target_inbound_message_id uuid,
  target_tool_call_id text,
  target_reason text,
  target_urgency text default 'normal'
)
returns table (handoff_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare inbound public.messages%rowtype; existing_id uuid; idempotency text;
begin
  perform public.require_messaging_service_role();
  if target_urgency not in ('normal', 'urgent') or length(btrim(coalesce(target_reason, ''))) not between 3 and 500
    or length(btrim(coalesce(target_tool_call_id, ''))) = 0 then raise exception using errcode = '22023', message = 'Message handoff is invalid'; end if;
  select * into inbound from public.messages where id = target_inbound_message_id and direction = 'inbound';
  if inbound.id is null then raise exception using errcode = '42501', message = 'Inbound message is unavailable'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('message-handoff:' || inbound.id::text, 0));
  idempotency := 'message:' || inbound.id::text || ':' || target_tool_call_id;
  select id into existing_id from public.handoffs where organization_id = inbound.organization_id and idempotency_key = idempotency;
  if existing_id is null then
    insert into public.handoffs (organization_id, location_id, conversation_id, reason, mode, urgency, idempotency_key)
    values (inbound.organization_id, inbound.location_id, inbound.conversation_id, btrim(target_reason), 'customer', target_urgency, idempotency)
    returning id into existing_id;
    update public.conversations set ai_mode = 'human', updated_at = now() where organization_id = inbound.organization_id and id = inbound.conversation_id;
    return query select existing_id, true;
  end if;
  return query select existing_id, false;
end;
$$;

create function public.get_sms_delivery_execution_context(target_message_id uuid)
returns table (message_id uuid, delivery_id uuid, to_e164 text, from_e164 text, body text, status text)
language sql stable security definer set search_path = '' as $$
  select message.id, delivery.id, contact.phone, phone.phone_number, message.body, delivery.status
  from public.messages message join public.message_deliveries delivery on delivery.organization_id = message.organization_id and delivery.message_id = message.id
  join public.conversations conversation on conversation.organization_id = message.organization_id and conversation.id = message.conversation_id
  join public.contacts contact on contact.organization_id = message.organization_id and contact.id = conversation.contact_id
  join public.phone_numbers phone on phone.organization_id = conversation.organization_id and phone.id = conversation.transport_phone_number_id
  where message.id = target_message_id and message.direction = 'outbound' and message.source_channel = 'sms'
    and delivery.provider = 'twilio' and delivery.status in ('queued', 'sending');
$$;

create function public.mark_sms_delivery_sending(target_message_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin perform public.require_messaging_service_role(); update public.message_deliveries set status = 'sending', status_rank = 1, attempted_at = now(), updated_at = now() where message_id = target_message_id and provider = 'twilio' and status = 'queued'; end;
$$;

create function public.record_sms_delivery_submission(target_message_id uuid, target_provider_message_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  if target_provider_message_id !~ '^SM[a-zA-Z0-9]{32}$' then raise exception using errcode = '22023', message = 'Provider message identifier is invalid'; end if;
  update public.message_deliveries set provider_message_id = target_provider_message_id, status = 'sent', status_rank = 2, sent_at = now(), updated_at = now()
    where message_id = target_message_id and provider = 'twilio' and status in ('queued', 'sending');
end;
$$;

create function public.mark_sms_delivery_unknown(target_message_id uuid, target_error_code text)
returns void language plpgsql security definer set search_path = '' as $$
begin perform public.require_messaging_service_role(); update public.message_deliveries set status = 'unknown', status_rank = 6, error_code = left(nullif(btrim(target_error_code), ''), 120), updated_at = now() where message_id = target_message_id and provider = 'twilio' and status in ('queued','sending'); end;
$$;

create function public.record_twilio_message_status(target_provider_message_id text, target_status text, target_error_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare incoming_rank integer; existing public.message_deliveries%rowtype;
begin
  perform public.require_messaging_service_role();
  incoming_rank := case target_status when 'queued' then 0 when 'sending' then 1 when 'sent' then 2 when 'delivered' then 3 when 'failed' then 4 when 'undelivered' then 5 else null end;
  if target_provider_message_id !~ '^SM[a-zA-Z0-9]{32}$' or incoming_rank is null then raise exception using errcode = '22023', message = 'Twilio status payload is invalid'; end if;
  select * into existing from public.message_deliveries where provider = 'twilio' and provider_message_id = target_provider_message_id for update;
  if existing.id is null or incoming_rank < existing.status_rank then return; end if;
  update public.message_deliveries set status = target_status, status_rank = incoming_rank, error_code = coalesce(left(nullif(btrim(target_error_code), ''), 120), error_code),
    delivered_at = case when target_status = 'delivered' then now() else delivered_at end, updated_at = now() where id = existing.id;
end;
$$;

-- Text scheduling confirmation is never model-provided: only an immutable later inbound message can claim an intent.
create function public.claim_conversation_scheduling_booking_intent(
  target_conversation_id uuid,
  target_inbound_message_id uuid,
  target_booking_intent_id uuid,
  target_tool_call_id text
)
returns table (state text, booking_intent_id uuid, confirmed_message_id uuid)
language plpgsql security definer set search_path = '' as $$
declare intent public.booking_intents%rowtype; inbound public.messages%rowtype;
begin
  perform public.require_scheduling_service_role();
  if length(btrim(coalesce(target_tool_call_id, ''))) = 0 then raise exception using errcode = '22023', message = 'Booking tool call is invalid'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0));
  select * into intent from public.booking_intents where id = target_booking_intent_id and conversation_id = target_conversation_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  if intent.status in ('completed', 'provider_success_pending_persistence', 'provider_state_unknown', 'booking') then
    return query select case when intent.status = 'booking' then 'booking_recovery' else intent.status end, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status <> 'awaiting_confirmation' then return query select intent.status, intent.id, intent.confirmed_message_id; return; end if;
  select * into inbound from public.messages where id = target_inbound_message_id and organization_id = intent.organization_id and conversation_id = intent.conversation_id
    and direction = 'inbound' and author_type = 'customer';
  if inbound.id is null or inbound.created_at <= intent.created_at or not public.is_explicit_booking_confirmation(inbound.body) then
    return query select 'confirmation_required'::text, intent.id, null::uuid; return; end if;
  update public.booking_intents set status = 'booking', booking_tool_call_id = target_tool_call_id, confirmed_message_id = inbound.id, updated_at = now() where id = intent.id;
  return query select 'claimed'::text, intent.id, inbound.id;
end;
$$;

-- Preserve the voice adapter while applying the same persisted-message confirmation invariant.
create or replace function public.claim_voice_scheduling_booking_intent(target_call_id text, target_booking_intent_id uuid, target_tool_call_id text)
returns table (state text, booking_intent_id uuid, confirmed_message_id uuid)
language plpgsql security definer set search_path = '' as $$
declare call_context record; intent public.booking_intents%rowtype; candidate public.booking_candidates%rowtype; inbound_message_id uuid; write_eligible boolean;
begin
  perform public.require_scheduling_service_role();
  if length(btrim(coalesce(target_tool_call_id, ''))) = 0 or length(target_tool_call_id) > 200 then raise exception using errcode = '22023', message = 'Booking tool call is invalid'; end if;
  select call.organization_id, call.location_id, call.conversation_id into call_context from public.calls as call where call.provider = 'openai-realtime-sip' and call.external_call_id = target_call_id;
  if call_context.organization_id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('booking-intent:' || target_booking_intent_id::text, 0));
  select * into intent from public.booking_intents where id = target_booking_intent_id and organization_id = call_context.organization_id and location_id = call_context.location_id and conversation_id = call_context.conversation_id;
  if intent.id is null then raise exception using errcode = '42501', message = 'Booking intent is not available'; end if;
  if intent.status = 'completed' then return query select 'completed'::text, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status in ('provider_success_pending_persistence', 'provider_state_unknown') then return query select intent.status, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status = 'booking' then return query select 'booking_recovery'::text, intent.id, intent.confirmed_message_id; return; end if;
  if intent.status <> 'awaiting_confirmation' then return query select intent.status, intent.id, intent.confirmed_message_id; return; end if;
  select * into candidate from public.booking_candidates where id = intent.candidate_id and organization_id = intent.organization_id and integration_id = intent.integration_id;
  if candidate.id is null or candidate.expires_at <= now() then update public.booking_intents set status = 'expired', updated_at = now() where id = intent.id; return query select 'expired'::text, intent.id, null::uuid; return; end if;
  select exists(
    select 1 from public.location_scheduling_settings as settings
    join public.integrations as integration on integration.organization_id = settings.organization_id and integration.location_id = settings.location_id and integration.id = settings.active_integration_id
    join public.scheduling_appointment_types as appointment_type on appointment_type.organization_id = intent.organization_id and appointment_type.id = candidate.appointment_type_id and appointment_type.integration_id = intent.integration_id
    join public.scheduling_resources as resource on resource.organization_id = intent.organization_id and resource.id = candidate.resource_id and resource.integration_id = intent.integration_id
    where settings.organization_id = intent.organization_id and settings.location_id = intent.location_id and settings.active_integration_id = intent.integration_id and integration.id = intent.integration_id and integration.status = 'connected' and appointment_type.active and appointment_type.bookable and resource.active and resource.bookable
      and (integration.provider = 'ezyvet' or exists (select 1 from public.scheduling_appointment_type_resources as mapping where mapping.organization_id = intent.organization_id and mapping.location_id = intent.location_id and mapping.integration_id = intent.integration_id and mapping.appointment_type_id = appointment_type.id and mapping.resource_id = resource.id))
  ) into write_eligible;
  if not write_eligible then update public.booking_intents set failure_category = 'configuration_changed', updated_at = now() where id = intent.id; return query select 'configuration_changed'::text, intent.id, null::uuid; return; end if;
  select id into inbound_message_id from public.messages where organization_id = intent.organization_id and conversation_id = intent.conversation_id and direction = 'inbound' and created_at > intent.created_at and public.is_explicit_booking_confirmation(body) order by created_at desc limit 1;
  if inbound_message_id is null then return query select 'confirmation_required'::text, intent.id, null::uuid; return; end if;
  update public.booking_intents set status = 'booking', booking_tool_call_id = target_tool_call_id, confirmed_message_id = inbound_message_id, failure_category = null, updated_at = now() where id = intent.id;
  return query select 'claimed'::text, intent.id, inbound_message_id;
end;
$$;

-- Existing authenticated policies allowed broad operational mutation.  Messaging state is now
-- strictly written through the auditable RPCs above; direct reads remain location scoped.
drop policy if exists messages_insert_member on public.messages;
drop policy if exists messages_update_member on public.messages;
drop policy if exists messages_delete_admin on public.messages;
drop policy if exists conversations_update_member on public.conversations;
drop policy if exists conversations_delete_admin on public.conversations;
drop policy if exists conversations_insert_member on public.conversations;
create policy messages_select_location_member on public.messages for select to authenticated
  using (public.has_location_access(organization_id, location_id));
create policy conversations_select_location_member on public.conversations for select to authenticated
  using (public.has_location_access(organization_id, location_id));

alter table public.message_processing_jobs enable row level security;
alter table public.message_deliveries enable row level security;
alter table public.messaging_contact_preferences enable row level security;
alter table public.web_chat_widgets enable row level security;
alter table public.web_chat_sessions enable row level security;
alter table public.messaging_rate_limits enable row level security;
create policy message_deliveries_select_location_member on public.message_deliveries for select to authenticated using (public.has_location_access(organization_id, location_id));
create policy web_chat_widgets_select_admin on public.web_chat_widgets for select to authenticated using (public.is_organization_admin(organization_id));

revoke all on table public.message_processing_jobs, public.message_deliveries, public.messaging_contact_preferences, public.web_chat_widgets, public.web_chat_sessions, public.messaging_rate_limits from public, anon, authenticated, service_role;
revoke all on function public.require_messaging_service_role(), public.normalized_web_chat_origin(text), public.consume_messaging_rate_limit(text, integer, integer), public.is_explicit_booking_confirmation(text), public.bootstrap_inbound_sms(text, text, text, text, jsonb, jsonb), public.claim_message_processing_jobs(text, integer), public.complete_message_processing_job(uuid), public.retry_message_processing_job(uuid, text), public.get_message_runtime_context(uuid), public.get_message_agent_context(uuid), public.has_persisted_ai_reply(uuid), public.request_message_handoff(uuid, text, text, text), public.persist_ai_message_reply(uuid, text, boolean), public.get_sms_delivery_execution_context(uuid), public.mark_sms_delivery_sending(uuid), public.record_sms_delivery_submission(uuid, text), public.mark_sms_delivery_unknown(uuid, text), public.record_twilio_message_status(text, text, text), public.claim_conversation_scheduling_booking_intent(uuid, uuid, uuid, text) from public;
revoke all on function public.create_web_chat_session(uuid, text, text, text), public.append_web_chat_message(text, text, uuid, text, text), public.get_web_chat_messages(text, text, timestamptz) from public;
revoke all on function public.get_my_inbox_conversations(uuid), public.get_my_inbox_messages(uuid), public.take_over_my_conversation(uuid), public.resume_my_conversation_ai(uuid), public.create_my_human_reply(uuid, text), public.get_my_web_chat_widget(uuid), public.upsert_my_web_chat_widget(uuid, boolean, jsonb, text) from public;
grant execute on function public.create_web_chat_session(uuid, text, text, text), public.append_web_chat_message(text, text, uuid, text, text), public.get_web_chat_messages(text, text, timestamptz) to anon, authenticated;
grant execute on function public.get_my_inbox_conversations(uuid), public.get_my_inbox_messages(uuid), public.take_over_my_conversation(uuid), public.resume_my_conversation_ai(uuid), public.create_my_human_reply(uuid, text), public.get_my_web_chat_widget(uuid), public.upsert_my_web_chat_widget(uuid, boolean, jsonb, text) to authenticated;
grant execute on function public.bootstrap_inbound_sms(text, text, text, text, jsonb, jsonb), public.claim_message_processing_jobs(text, integer), public.complete_message_processing_job(uuid), public.retry_message_processing_job(uuid, text), public.get_message_runtime_context(uuid), public.get_message_agent_context(uuid), public.has_persisted_ai_reply(uuid), public.request_message_handoff(uuid, text, text, text), public.persist_ai_message_reply(uuid, text, boolean), public.get_sms_delivery_execution_context(uuid), public.mark_sms_delivery_sending(uuid), public.record_sms_delivery_submission(uuid, text), public.mark_sms_delivery_unknown(uuid, text), public.record_twilio_message_status(text, text, text), public.claim_conversation_scheduling_booking_intent(uuid, uuid, uuid, text) to service_role;
