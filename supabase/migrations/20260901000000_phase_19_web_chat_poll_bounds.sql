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
--    of once a request. Session lifetime semantics are deliberately preserved: an active session
--    still rolls forward to 24 hours from now, and an idle one still expires exactly as before.
--    The only thing that changes is how often the same conclusion is written down. The one-minute
--    coalescing window is two orders of magnitude smaller than the 24-hour lifetime, so no session
--    can expire while its owner is still polling.
--
-- The signature gains `target_rate_scope`, matching the two sibling RPCs, so the old two-argument
-- form is dropped and replaced rather than left behind as an unlimited path. Every caller is
-- updated in the same change.
--
-- Privileges are stated explicitly. A function created after the Phase 18 hardening inherits the
-- hosted platform's `auto_expose_new_tables` default again, so without these lines this RPC would
-- be born executable by anon and authenticated -- exactly the regression
-- supabase/tests/database/privilege_regression.test.sql exists to catch.

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
