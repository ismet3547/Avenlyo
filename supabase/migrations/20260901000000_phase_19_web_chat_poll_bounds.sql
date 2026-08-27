-- Bound what one web-chat browser can demand by polling.
--
-- `get_web_chat_messages` is the only public web-chat entry point that had no rate limit at all.
-- Session creation and message submission both consume `consume_messaging_rate_limit`; polling
-- consumed nothing, so a client holding one valid session token could call it as fast as the
-- network allowed. Each of those calls did real work:
--
--   update public.web_chat_sessions
--      set last_active_at = now(), expires_at = now() + interval '24 hours', updated_at = now()
--
-- an unconditional row update on every single poll. That is write amplification with no ceiling:
-- one browser in a loop produces a continuous stream of row versions, WAL, and autovacuum work on
-- a table every other web-chat request also reads. The read itself was already bounded at 100 rows;
-- the write was not bounded by anything.
--
-- Two additive changes, both inside the existing primitive rather than a second mechanism:
--
-- 1. The same `consume_messaging_rate_limit` the other two entry points use, under a `web-poll:`
--    prefix so a client that has exhausted polling can still send a message. 240 per minute is
--    deliberately far above what the widget does -- it polls a few times a minute -- and far below
--    what a loop achieves. The API's in-process limiter refuses long before this in the normal
--    case; this is the durable backstop that still holds when there is more than one API replica.
--
-- 2. The touch is coalesced. `last_active_at` and `expires_at` only move when the recorded activity
--    is already at least a minute stale, so a polling browser writes at most once a minute instead
--    of once a request.
--
--    This is a real, bounded change to expiry timing, and worth stating precisely rather than
--    calling the lifetime "unchanged". Expiry is now 24 hours after the last *persisted* activity,
--    not 24 hours after the last request. A poll landing inside the coalescing window leaves
--    `expires_at` where the previous write put it, so the effective TTL can sit up to 60 seconds
--    behind an exact "last poll + 24h" model, and never ahead of it.
--
--    What that cannot do is expire a session someone is still using: the drift is bounded by the
--    one-minute window, which is roughly three orders of magnitude smaller than the 24-hour
--    lifetime, so any client still polling refreshes the row long before expiry approaches. An idle
--    session still expires on exactly the same schedule as before, because the last write is the
--    last activity either way.
--
-- The signature gains `target_rate_scope`, matching the two sibling RPCs. The old two-argument form
-- is not left behind as an unlimited path -- its implementation is removed -- but the signature is
-- recreated at the bottom of this file as a bounded delegate, so a rolled-back Phase 18 binary can
-- still make its exact old call. See the note above that function for why.
--
-- This migration also advances `platform_schema_contract` to 19, because a Phase 19 build genuinely
-- depends on the three-argument function existing and must refuse to report ready without it.
--
-- Privileges are stated explicitly. A function created after the Phase 18 hardening inherits the
-- hosted platform's `auto_expose_new_tables` default again, so without these lines this RPC would
-- be born executable by anon and authenticated -- exactly the regression
-- supabase/tests/database/privilege_regression.test.sql exists to catch.

-- The old two-argument implementation is replaced, not merely shadowed: it is recreated further
-- down as a bounded delegate so a rolled-back Phase 18 binary keeps working.
drop function if exists public.get_web_chat_messages(text, timestamptz);

create function public.get_web_chat_messages(
  target_token_hash text,
  target_rate_scope text,
  target_after timestamptz default null
)
returns table (message_id uuid, direction text, author_type text, body text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare session_row public.web_chat_sessions%rowtype;
begin
  perform public.require_messaging_service_role();
  if target_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Web chat session is invalid';
  end if;
  if target_rate_scope is null or target_rate_scope !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Web chat session is invalid';
  end if;

  -- Charged before the session lookup, so an invalid token cannot be used as an unmetered probe.
  if not public.consume_messaging_rate_limit('web-poll:' || target_rate_scope, 240, 60) then
    raise exception using errcode = '42901', message = 'Too many web chat polls';
  end if;

  select * into session_row from public.web_chat_sessions
    where token_hash = target_token_hash and expires_at > now();
  if session_row.id is null then
    raise exception using errcode = '42501', message = 'Web chat session is unavailable';
  end if;

  -- Coalesced: the same rolling 24-hour extension, written at most once a minute per session.
  if session_row.last_active_at is null or session_row.last_active_at <= now() - interval '1 minute' then
    update public.web_chat_sessions
      set last_active_at = now(), expires_at = now() + interval '24 hours', updated_at = now()
      where id = session_row.id;
  end if;

  return query select message.id, message.direction, message.author_type, message.body, message.created_at
    from public.messages message
    where message.organization_id = session_row.organization_id
      and message.conversation_id = session_row.conversation_id
      and (target_after is null or message.created_at > target_after)
    order by message.created_at asc, message.id asc
    limit 100;
end;
$$;

revoke all on function public.get_web_chat_messages(text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.get_web_chat_messages(text, text, timestamptz) to service_role;

-- Rollback compatibility: the Phase 18 call shape must keep working, without its old behaviour.
--
-- The readiness contract in apps/api/src/observability/readiness.ts deliberately accepts a schema
-- newer than the running build requires, so a release can be rolled back to the previous image
-- without a destructive down-migration. Dropping the two-argument overload outright would have
-- broken that promise in the worst way: readiness would stay green while a rolled-back Phase 18
-- binary got "function does not exist" on every web-chat poll.
--
-- So the old signature survives -- exact parameter names and types, because PostgREST calls RPCs by
-- name and the old binary sends {target_token_hash, target_after} -- but it is a thin delegate, not
-- the old implementation. It cannot reintroduce the unlimited poll path, because it has no path of
-- its own: rate limiting, session lookup, coalesced touch and the 100-row bound all happen inside
-- the three-argument function it calls.
--
-- The one thing it must supply that the old binary cannot is a rate scope. That build predates the
-- trusted-proxy work and has no client address to offer, so the scope is derived deterministically
-- from the session token hash instead. That is a per-session bucket rather than a per-client one --
-- coarser than the current path, and deliberately so: it still bounds any single session's polling,
-- and a rolled-back release is a temporary state, not the model to optimise for.
--
-- ## Why this path checks the session first, and the three-argument one does not
--
-- The authoritative function charges the quota *before* the session lookup, so an invalid token
-- cannot be used as an unmetered probe. That is right there, because its scope comes from the
-- canonical client address: the key space is the set of client addresses, and rotating chat tokens
-- mints no new scopes.
--
-- It is wrong here. A rolled-back Phase 18 binary has no edge limiter and accepts any syntactically
-- valid 43-character token, so the scope this wrapper derives is attacker-controlled. Delegating
-- straight through would mean every rotated token became a fresh `web-poll:` scope and therefore a
-- fresh row in `messaging_rate_limits`, whose primary key is `scope_key` -- unbounded durable state
-- created by a caller who never held a session, with the 42501 arriving only afterwards.
--
-- So this path proves the session exists before it creates any limiter state, using the
-- (token_hash, expires_at) index that already exists for exactly this lookup. A caller without a
-- live session gets the same bounded 42501 and leaves nothing behind. The three-argument function
-- then repeats the lookup, which is one indexed read on the path that already succeeded -- a cost
-- worth paying to keep one implementation of the actual polling behaviour rather than two.
--
-- Overload resolution is unambiguous in both directions and asserted in
-- supabase/tests/database/web_chat_poll_bounds.test.sql: only this function has `target_after`
-- without `target_rate_scope`, and only the three-argument one has `target_rate_scope` at all.
create function public.get_web_chat_messages(
  target_token_hash text,
  target_after timestamptz default null
)
returns table (message_id uuid, direction text, author_type text, body text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_messaging_service_role();
  if target_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Web chat session is invalid';
  end if;

  -- The gate. Existence only -- no columns are read, nothing is written, and no limiter scope is
  -- derived until a live session is proven. Same error and message the authoritative function
  -- raises for the same condition, so a rolled-back binary sees no behavioural difference.
  if not exists (
    select 1 from public.web_chat_sessions
    where token_hash = target_token_hash and expires_at > now()
  ) then
    raise exception using errcode = '42501', message = 'Web chat session is unavailable';
  end if;

  -- Everything that actually polls -- quota, session lookup, coalesced touch, 100-row bound --
  -- belongs to the three-argument function. This wrapper adds a gate and a scope, nothing else.
  return query select * from public.get_web_chat_messages(
    target_token_hash,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to('legacy-poll:' || target_token_hash, 'UTF8')),
      'hex'
    ),
    target_after
  );
end;
$$;

revoke all on function public.get_web_chat_messages(text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.get_web_chat_messages(text, timestamptz) to service_role;

-- The Phase 19 application depends on the three-argument poll contract above. A Phase 19 build must
-- refuse to report ready against an 18 database, which is exactly what this version bump makes the
-- readiness probe do.
update public.platform_schema_contract
set schema_version = 19, updated_at = now()
where id;
