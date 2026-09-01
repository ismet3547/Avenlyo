-- Phase 19: what one browser can demand by polling.
--
-- Before this, `get_web_chat_messages` was the only public web-chat entry point with no rate limit,
-- and it wrote to `web_chat_sessions` on every single call. These assertions pin both halves of the
-- repair: the durable quota now exists, and the session touch is coalesced -- along with the price
-- of that coalescing, which is a bounded sub-minute expiry drift rather than an unchanged lifetime.

begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(24);

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

-- Exactly two overloads, and exactly these two. The current three-argument path, and the Phase 18
-- signature kept so a rolled-back binary can still make its old call. Anything else appearing here
-- is either an unlimited path returning or a rollback path being deleted.
select extensions.set_eq(
  $q$ select pg_get_function_identity_arguments(p.oid)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'get_web_chat_messages' $q$,
  $q$ values
      ('target_token_hash text, target_rate_scope text, target_after timestamp with time zone'),
      ('target_token_hash text, target_after timestamp with time zone')
  $q$,
  'exactly the current overload and the Phase 18 rollback overload exist'
);

select extensions.ok(
  has_function_privilege('service_role', 'public.get_web_chat_messages(text,text,timestamptz)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.get_web_chat_messages(text,timestamptz)', 'EXECUTE'),
  'the backend can execute both overloads'
);

select extensions.ok(
  not has_function_privilege('anon', 'public.get_web_chat_messages(text,text,timestamptz)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.get_web_chat_messages(text,text,timestamptz)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_web_chat_messages(text,timestamptz)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.get_web_chat_messages(text,timestamptz)', 'EXECUTE'),
  'no client role can execute either overload, despite both being created after the Phase 18 hardening'
);

select extensions.ok(
  (select bool_and(p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_web_chat_messages'),
  'both overloads are security definer'
);

select extensions.ok(
  (select bool_and(p.proconfig @> array['search_path=""'])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_web_chat_messages'),
  'both overloads pin an empty search_path'
);

-- This suite originated in Phase 19, but the repository-level schema contract is global. Phase 23
-- now includes the final provider-uncertainty retry boundary, so the current database must be 22.
select extensions.is(
  (select schema_version from public.platform_schema_contract where id),
  22,
  'the current schema contract is 22 after the final Phase 23 migrations'
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
  'an active session still rolls forward to roughly 24 hours from the persisted activity'
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

-- The cost of that: expiry tracks the last *persisted* activity, not the last request. The drift is
-- bounded by the coalescing window and is always behind, never ahead -- stated here rather than
-- claiming the lifetime is untouched, because it is not.
select extensions.ok(
  (select expires_at <= now() + interval '24 hours' from public.web_chat_sessions
    where id = 'c1500000-0000-0000-0000-000000000001'),
  'expiry after a coalesced poll is never ahead of last-request + 24h'
);

select extensions.ok(
  (select expires_at > now() + interval '24 hours' - interval '60 seconds'
     from public.web_chat_sessions where id = 'c1500000-0000-0000-0000-000000000001'),
  'and never more than the one-minute coalescing window behind it'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

-- ---------------------------------------------------------------------------------------
-- Rollback compatibility
--
-- These pin the exact call a Phase 18 binary makes. PostgREST invokes an RPC with named
-- arguments, so the parameter *names* are part of the contract, not just the types -- which is why
-- the assertions below use named-argument syntax rather than positional. A future migration that
-- deletes or renames this overload fails here rather than in production after a rollback.
-- ---------------------------------------------------------------------------------------

select extensions.lives_ok(
  $$ select * from public.get_web_chat_messages(
       target_token_hash => repeat('a', 64),
       target_after => null
     ) $$,
  'the Phase 18 named-argument call shape still resolves and runs'
);

select extensions.is(
  (select count(*)::integer from public.get_web_chat_messages(
     target_token_hash => repeat('a', 64), target_after => null)),
  1,
  'and returns the same session history the current overload does'
);

select extensions.lives_ok(
  $$ select * from public.get_web_chat_messages(
       target_token_hash => repeat('a', 64),
       target_rate_scope => repeat('b', 64),
       target_after => null
     ) $$,
  'the Phase 19 named-argument call shape resolves to the three-argument overload'
);

-- ---------------------------------------------------------------------------------------
-- An invalid legacy token must leave nothing behind.
--
-- A rolled-back Phase 18 binary has no edge limiter and accepts any syntactically valid token, so
-- the scope the wrapper derives comes from a caller-supplied value. Delegating straight through
-- would let an unknown token reach consume_messaging_rate_limit and execute its INSERT ... ON
-- CONFLICT -- which the subsequent 42501 then rolls back, in the same transaction. No committed row
-- survives either way, so this was never durable cardinality growth. The gate's value is that an
-- unknown token does not reach the limiter at all: no aborted INSERT, no WAL, no dead tuple, and no
-- dependence on a future caller propagating the error rather than swallowing it.
--
-- Two separate things are asserted below, and it is worth being exact about which is which,
-- because they are not equally strong.
--
-- The row-count assertions pin the *invariant*: rotating unknown tokens must not grow durable
-- limiter state. They hold both with and without the wrapper's gate, because the 42501 aborts the
-- transaction and rolls back the INSERT ... ON CONFLICT the limiter made moments earlier. Verified
-- directly against a real database, outside any test harness, with the gate removed. So these are
-- a guard on the property, not a demonstration that the gate is what provides it.
--
-- The structural assertion below pins the *gate*. It is what fails if someone deletes the check,
-- and it exists because the invariant currently rests on transactional rollback -- which is true
-- today and would stop being true the moment any caller wrapped this RPC in an exception handler,
-- a subtransaction, or a retry loop that swallowed the error. The gate makes the property
-- independent of that.
--
-- The refusal assertions use correctly formatted 64-hex hashes that map to no session, which is the
-- shape that matters; a malformed hash is caught by the format check and proves nothing here.
-- ---------------------------------------------------------------------------------------

select extensions.ok(
  (select position('web_chat_sessions' in p.prosrc) > 0
            and position('web_chat_sessions' in p.prosrc)
                < position('get_web_chat_messages' in p.prosrc)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_web_chat_messages'
      and pg_get_function_identity_arguments(p.oid) not like '%rate_scope%'),
  'the rollback overload proves a live session BEFORE it delegates and derives a limiter scope'
);

reset role;
create temp table limiter_before as
  select count(*)::integer as rows from public.messaging_rate_limits;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.throws_ok(
  $$ select * from public.get_web_chat_messages(
       target_token_hash => repeat('d', 64), target_after => null) $$,
  '42501',
  'Web chat session is unavailable',
  'a well-formed but unknown legacy token is refused'
);

select extensions.throws_ok(
  $$ select * from public.get_web_chat_messages(
       target_token_hash => repeat('e', 64), target_after => null) $$,
  '42501',
  'Web chat session is unavailable',
  'and so is the next one, and the next'
);

do $$
declare index integer;
begin
  -- Rotate a batch, the way an attacker would.
  for index in 1..25 loop
    begin
      perform * from public.get_web_chat_messages(
        target_token_hash => pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to('rotated-' || index::text, 'UTF8')), 'hex'),
        target_after => null);
    exception when others then null;
    end;
  end loop;
end $$;

reset role;

select extensions.is(
  (select count(*)::integer from public.messaging_rate_limits),
  (select rows from limiter_before),
  'rotating 27 unknown legacy tokens grew durable limiter state by nothing'
);

-- Named precisely rather than by pattern: no scope derived from any rotated token exists.
select extensions.is_empty(
  $q$ select limits.scope_key
        from public.messaging_rate_limits limits
        join generate_series(1, 25) as rotated(index)
          on limits.scope_key = 'web-poll:' || encode(
               sha256(convert_to('legacy-poll:' || encode(
                 sha256(convert_to('rotated-' || rotated.index::text, 'UTF8')), 'hex'), 'UTF8')),
               'hex') $q$,
  'not one rotated token minted a durable limiter scope'
);

-- The compatibility path is a delegate, not a restoration: it consumes the same durable quota. Its
-- scope is derived from the token hash, so spending that bucket directly must refuse it. Spent as
-- postgres: the limiter helper is internal and executable by no client or backend role.
reset role;
do $$
declare index integer;
  legacy_scope text := encode(sha256(convert_to('legacy-poll:' || repeat('a', 64), 'UTF8')), 'hex');
begin
  for index in 1..240 loop
    perform public.consume_messaging_rate_limit('web-poll:' || legacy_scope, 240, 60);
  end loop;
end $$;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select extensions.throws_ok(
  $$ select * from public.get_web_chat_messages(
       target_token_hash => repeat('a', 64), target_after => null) $$,
  '42901',
  'Too many web chat polls',
  'the rollback overload is durably bounded, not the old unlimited path'
);

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