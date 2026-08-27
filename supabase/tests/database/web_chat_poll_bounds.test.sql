-- Phase 19: what one browser can demand by polling.
--
-- Before this, `get_web_chat_messages` was the only public web-chat entry point with no rate limit,
-- and it wrote to `web_chat_sessions` on every single call. These assertions pin both halves of the
-- repair: the durable quota now exists, and the session touch is coalesced without changing what a
-- session's lifetime means.

begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(12);

set local role postgres;

insert into public.organizations (id, name, slug)
values ('c1000000-0000-0000-0000-000000000001', 'Poll Bounds Co', 'poll-bounds-co');

insert into public.locations (id, organization_id, name, timezone)
values ('c1100000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'Main', 'UTC');

insert into public.channels (id, organization_id, location_id, channel_type, display_name, status)
values ('c1700000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001',
        'c1100000-0000-0000-0000-000000000001', 'web', 'Website chat', 'active');

insert into public.web_chat_widgets (id, organization_id, location_id, channel_id, public_key, enabled, allowed_origins)
values ('c1200000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001',
        'c1100000-0000-0000-0000-000000000001', 'c1700000-0000-0000-0000-000000000001',
        'c1300000-0000-0000-0000-000000000001', true, '["https://poll.example"]'::jsonb);

insert into public.conversations (id, organization_id, location_id, channel_id, status)
values ('c1400000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001',
        'c1100000-0000-0000-0000-000000000001', 'c1700000-0000-0000-0000-000000000001', 'open');

-- A session whose recorded activity is deliberately old, so the first poll must refresh it.
insert into public.web_chat_sessions
  (id, organization_id, location_id, widget_id, conversation_id, token_hash, origin,
   last_active_at, expires_at, created_at, updated_at)
values ('c1500000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001',
        'c1100000-0000-0000-0000-000000000001', 'c1200000-0000-0000-0000-000000000001',
        'c1400000-0000-0000-0000-000000000001', repeat('a', 64), 'https://poll.example',
        now() - interval '10 minutes', now() + interval '1 hour', now() - interval '10 minutes',
        now() - interval '10 minutes');

insert into public.messages (id, organization_id, location_id, conversation_id, direction, author_type, body)
values ('c1600000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001',
        'c1100000-0000-0000-0000-000000000001', 'c1400000-0000-0000-0000-000000000001',
        'inbound', 'customer', 'Are you open?');

reset role;

-- ---------------------------------------------------------------------------------------
-- Shape and privilege
-- ---------------------------------------------------------------------------------------

select extensions.is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_web_chat_messages'),
  1,
  'exactly one get_web_chat_messages remains -- the unlimited two-argument form is gone'
);

select extensions.ok(
  has_function_privilege('service_role', 'public.get_web_chat_messages(text,text,timestamptz)', 'EXECUTE'),
  'the backend can still read a session history'
);

select extensions.ok(
  not has_function_privilege('anon', 'public.get_web_chat_messages(text,text,timestamptz)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.get_web_chat_messages(text,text,timestamptz)', 'EXECUTE'),
  'no client role can execute it, despite being created after the Phase 18 hardening'
);

select extensions.is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_web_chat_messages'),
  true,
  'it is still security definer'
);

select extensions.ok(
  (select p.proconfig @> array['search_path=""']
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_web_chat_messages'),
  'it still pins an empty search_path'
);

-- ---------------------------------------------------------------------------------------
-- Behaviour
-- ---------------------------------------------------------------------------------------

-- The RPC is called as service_role, but the table itself is read back as postgres: Phase 18
-- deliberately left service_role no direct table privilege, so a test that read the session row
-- under that role would be asserting against the wrong security model.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.is(
  (select count(*)::integer from public.get_web_chat_messages(repeat('a', 64), repeat('b', 64), null)),
  1,
  'a valid session still reads its own history'
);

reset role;
create temp table poll_probe as
  select last_active_at, expires_at, xmin::text as row_version
    from public.web_chat_sessions where id = 'c1500000-0000-0000-0000-000000000001';

select extensions.ok(
  (select last_active_at > now() - interval '5 seconds' from poll_probe),
  'a poll after the coalescing window still refreshes the session'
);

select extensions.ok(
  (select expires_at > now() + interval '23 hours' from poll_probe),
  'the rolling 24-hour lifetime is unchanged -- an active session still rolls forward'
);

-- The touch just happened, so a second poll must not write the same conclusion again.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select count(*) from public.get_web_chat_messages(repeat('a', 64), repeat('b', 64), null);
reset role;

select extensions.is(
  (select xmin::text from public.web_chat_sessions where id = 'c1500000-0000-0000-0000-000000000001'),
  (select row_version from poll_probe),
  'a second poll inside the coalescing window produces no new row version'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.throws_ok(
  $$ select * from public.get_web_chat_messages(repeat('a', 64), 'not-a-scope', null) $$,
  '22023',
  'Web chat session is invalid',
  'a malformed rate scope is refused rather than used as an unbounded key'
);

select extensions.throws_ok(
  $$ select * from public.get_web_chat_messages('short', repeat('b', 64), null) $$,
  '22023',
  'Web chat session is invalid',
  'a malformed token is still refused'
);

-- Spend the durable poll allowance and prove the ceiling exists. The scope is distinct from the one
-- used above so the earlier assertions keep their own budget. Run as postgres: the limiter helper
-- is internal and, correctly, executable by no client or backend role.
reset role;
do $$
declare index integer;
begin
  for index in 1..240 loop
    perform public.consume_messaging_rate_limit('web-poll:' || repeat('c', 64), 240, 60);
  end loop;
end $$;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.throws_ok(
  $$ select * from public.get_web_chat_messages(repeat('a', 64), repeat('c', 64), null) $$,
  '42901',
  'Too many web chat polls',
  'the durable poll quota refuses a client that has exhausted it'
);

reset role;
select * from extensions.finish();
rollback;
