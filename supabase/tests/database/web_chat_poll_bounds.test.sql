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

-- This suite originated in Phase 19, but the repository-level schema contract is global. Later
-- additive migrations may advance it; this historical suite only requires the Phase 23 closure.
select extensions.cmp_ok(
  (select schema_version from public.platform_schema_contract where id),
  '>=',
  22,
  'the current schema contract remains compatible with the final Phase 23 migrations'
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
-- would let an unknown token reach consume_messaging_rate_limit and execute its INSERT‹‹ˆÓ‚‹KHÓÓ‘“PÕKHÚXÚHİXœÙ\]Y[LH[ˆ›ÛÈ˜XÚË[ˆHØ[YH˜[œØXİ[Û‹ˆ›ÈÛÛ[Z]Y›İÂ‹KHİ\š]™\ÈZ]\ˆØ^KÛÈ\ÈØ\È™]™\ˆ\˜X›HØ\™[˜[]HÜ›İİˆHØ]IÜÈ˜[YH\È][‚‹KH[šÛ›İÛˆÚÙ[ˆÙ\È›İ™XXÚH[Z]\ˆ][ˆ›ÈX›ÜYS”ÑT•›ÈĞS›ÈXY\K[™›Â‹KH\[™[˜ÙHÛˆH]\™HØ[\ˆ›ÜYØ][™ÈH\œ›Üˆ˜]\ˆ[ˆİØ[İÚ[™È]‚‹KB‹KHÛÈÙ\\˜]H[™ÜÈ\™H\ÜÙ\Y™[İË[™]\ÈÛÜ™Z[™È^XİX›İ]ÚXÚ\ÈÚXÚ‹KH™XØ]\ÙH^H\™H›İ\]X[Hİ›Û™Ë‚‹KB‹KHH›İËXÛİ[\ÜÙ\[ÛœÈ[ˆH
š[˜\šX[
ˆ›İ][™È[šÛ›İÛˆÚÙ[œÈ]\İ›İÜ›İÈ\˜X›B‹KH[Z]\ˆİ]Kˆ^HÛ›İÚ][™Ú]İ]HÜ˜\\‰ÜÈØ]K™XØ]\ÙHHLHX›ÜÈB‹KH˜[œØXİ[Ûˆ[™›ÛÈ˜XÚÈHS”ÑT•‹‹ˆÓˆÓÓ‘“PÕH[Z]\ˆXYH[ÛY[ÈX\›Y\‹ˆ™\šYšYY‹KH\™XİHYØZ[œİH™X[]X˜\ÙKİ]ÚYH[H\İ\›™\ÜËÚ]HØ]H™[[İ™YˆÛÈ\ÙH\™B‹KHHİX\™ÛˆH›Ü\K›İH[[Ûœİ˜][Ûˆ]HØ]H\ÈÚ]›İšY\È]‚‹KB‹KHHİXİ\˜[\ÜÙ\[Ûˆ™[İÈ[œÈH
™Ø]J‹ˆ]\ÈÚ]˜Z[ÈYˆÛÛY[Û™H[]\ÈHÚXÚË‹KH[™]^\İÈ™XØ]\ÙHH[˜\šX[İ\œ™[H™\İÈÛˆ˜[œØXİ[Û˜[›Û˜XÚÈKHÚXÚ\ÈYB‹KHÙ^H[™Ûİ[İÜ™Z[™ÈYHH[ÛY[[HØ[\ˆÜ˜\Y\È”È[ˆ[ˆ^Ù\[Ûˆ[™\‹‹KHHİX˜[œØXİ[Û‹ÜˆH™]HÛÜ]İØ[İÙYH\œ›Ü‹ˆHØ]HXZÙ\ÈH›Ü\B‹KH[™\[™[Ùˆ]‚‹KB‹KHH™Y\Ø[\ÜÙ\[ÛœÈ\ÙHÛÜœ™XİH›Ü›X]YZ^\Ú\È]X\È›ÈÙ\ÜÚ[Û‹ÚXÚ\ÈB‹KHÚ\H]X]\œÎÈHX[›Ü›YY\Ú\ÈØ]YÚHH›Ü›X]ÚXÚÈ[™›İ™\È›İ[™È\™K‚‹KHKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKB‚œÙ[Xİ^[œÚ[ÛœË›ÚÊˆ
Ù[XİÜÚ][ÛŠ	İÙX—ØÚ]ÜÙ\ÜÚ[ÛœÉÈ[ˆœ›ÜÜ˜ÊHˆˆ[™ÜÚ][ÛŠ	İÙX—ØÚ]ÜÙ\ÜÚ[ÛœÉÈ[ˆœ›ÜÜ˜ÊBˆÜÚ][ÛŠ	ÙÙ]İÙX—ØÚ]ÛY\ÜØYÙ\ÉÈ[ˆœ›ÜÜ˜ÊBˆœ›ÛH×Ü›ØÈ›Ú[ˆ×Û˜[Y\ÜXÙHˆÛˆ‹›ÚYHœ›Û˜[Y\ÜXÙBˆÚ\™H‹›œÜ˜[YHH	ÜX›XÉÈ[™œ›Û˜[YHH	ÙÙ]İÙX—ØÚ]ÛY\ÜØYÙ\ÉÂˆ[™×ÙÙ]Ù[˜İ[Û—ÚY[]WØ\™İ[Y[Ê›ÚY
H›İZÙH	É\˜]WÜØÛÜIIÊKˆ	İH›Û˜XÚÈİ™\›ØY›İ™\ÈH]™HÙ\ÜÚ[Ûˆ‘Q“Ô‘H][YØ]\È[™\š]™\ÈH[Z]\ˆØÛÜIÂŠNÂ‚œ™\Ù]›ÛNÂ˜Ü™X]H[\X›H[Z]\—Ø™Y›Ü™H\ÂˆÙ[XİÛİ[

ŠNš[YÙ\ˆ\È›İÜÈœ›ÛHX›XË›Y\ÜØYÚ[™×Ü˜]WÛ[Z]ÎÂ‚œÙ]ØØ[›ÛHÙ\šXÙWÜ›ÛNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[Kœ›ÛIË	ÜÙ\šXÙWÜ›ÛIËYJNÂ‚œÙ[Xİ^[œÚ[ÛœË›İÜ×ÛÚÊˆ		Ù[Xİ
ˆœ›ÛHX›XË™Ù]İÙX—ØÚ]ÛY\ÜØYÙ\Êˆ\™Ù]İÚÙ[—Ú\ÚOˆ™\X]
	Ù	Ë
K\™Ù]ØY\ˆOˆ[
H		ˆ	ÍLIËˆ	ÕÙXˆÚ]Ù\ÜÚ[Ûˆ\È[˜]˜Z[X›IËˆ	ØHÙ[Y›Ü›YY][šÛ›İÛˆYØXŞHÚÙ[ˆ\È™Y\ÙY	ÂŠNÂ‚œÙ[Xİ^[œÚ[ÛœË›İÜ×ÛÚÊˆ		Ù[Xİ
ˆœ›ÛHX›XË™Ù]İÙX—ØÚ]ÛY\ÜØYÙ\Êˆ\™Ù]İÚÙ[—Ú\ÚOˆ™\X]
	ÙIË
K\™Ù]ØY\ˆOˆ[
H		ˆ	ÍLIËˆ	ÕÙXˆÚ]Ù\ÜÚ[Ûˆ\È[˜]˜Z[X›IËˆ	Ø[™ÛÈ\ÈH™^Û™K[™H™^	ÂŠNÂ‚™È		™XÛ\™H[™^[YÙ\Â˜™YÚ[‚ˆKH›İ]HH˜]ÚHØ^H[ˆ]XÚÙ\ˆÛİ[‚ˆ›Üˆ[™^[ˆK‹ŒHÛÜˆ™YÚ[‚ˆ\™›Ü›H
ˆœ›ÛHX›XË™Ù]İÙX—ØÚ]ÛY\ÜØYÙ\Êˆ\™Ù]İÚÙ[—Ú\ÚOˆ×ØØ][ÙË™[˜ÛÙJˆ×ØØ][ÙËœÚLMŠ×ØØ][ÙË˜ÛÛ™\İÊ	Ü›İ]YIÈ[™^^	ÕU	ÊJK	Ú^	ÊKˆ\™Ù]ØY\ˆOˆ[
NÂˆ^Ù\[ÛˆÚ[ˆİ\œÈ[ˆ[Âˆ[™Âˆ[™ÛÜÂ™[™		Â‚œ™\Ù]›ÛNÂ‚œÙ[Xİ^[œÚ[ÛœËš\Êˆ
Ù[XİÛİ[

ŠNš[YÙ\ˆœ›ÛHX›XË›Y\ÜØYÚ[™×Ü˜]WÛ[Z]ÊKˆ
Ù[Xİ›İÜÈœ›ÛH[Z]\—Ø™Y›Ü™JKˆ	Ü›İ][™ÈÈ[šÛ›İÛˆYØXŞHÚÙ[œÈÜ™]È\˜X›H[Z]\ˆİ]HH›İ[™ÉÂŠNÂ‚‹KH˜[YY™XÚ\Ù[H˜]\ˆ[ˆH]\›ˆ›ÈØÛÜH\š]™Yœ›ÛH[H›İ]YÚÙ[ˆ^\İË‚œÙ[Xİ^[œÚ[ÛœËš\×Ù[\Jˆ	IÙ[Xİ[Z]ËœØÛÜWÚÙ^Bˆœ›ÛHX›XË›Y\ÜØYÚ[™×Ü˜]WÛ[Z]È[Z]Âˆ›Ú[ˆÙ[™\˜]WÜÙ\šY\ÊKJH\È›İ]Y
[™^
BˆÛˆ[Z]ËœØÛÜWÚÙ^HH	İÙX‹\Û‰È[˜ÛÙJˆÚLMŠÛÛ™\İÊ	ÛYØXŞK\Û‰È[˜ÛÙJˆÚLMŠÛÛ™\İÊ	Ü›İ]YIÈ›İ]Yš[™^^	ÕU	ÊJK	Ú^	ÊK	ÕU	ÊJKˆ	Ú^	ÊH	Iˆ	Û›İÛ™H›İ]YÚÙ[ˆZ[YH\˜X›H[Z]\ˆØÛÜIÂŠNÂ‚‹KHHÛÛ\]Xš[]H]\ÈH[YØ]K›İH™\İÜ˜][Ûˆ]ÛÛœİ[Y\ÈHØ[YH\˜X›H][İKˆ]Â‹KHØÛÜH\È\š]™Yœ›ÛHHÚÙ[ˆ\ÚÛÈÜ[™[™È]XÚÙ]\™XİH]\İ™Y\ÙH]ˆÜ[\Â‹KHÜİÜ™\ÎˆH[Z]\ˆ[\ˆ\È[\›˜[[™^Xİ]X›HH›ÈÛY[Üˆ˜XÚÙ[™›ÛK‚œ™\Ù]›ÛNÂ™È		™XÛ\™H[™^[YÙ\ÂˆYØXŞWÜØÛÜH^H[˜ÛÙJÚLMŠÛÛ™\İÊ	ÛYØXŞK\Û‰È™\X]
	ØIË
K	ÕU	ÊJK	Ú^	ÊNÂ˜™YÚ[‚ˆ›Üˆ[™^[ˆK‹ŒÛÜˆ\™›Ü›HX›XË˜ÛÛœİ[YWÛY\ÜØYÚ[™×Ü˜]WÛ[Z]
	İÙX‹\Û‰ÈYØXŞWÜØÛÜKŒ
NÂˆ[™ÛÜÂ™[™		Â‚œÙ]ØØ[›ÛHÙ\šXÙWÜ›ÛNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[Kœ›ÛIË	ÜÙ\šXÙWÜ›ÛIËYJNÂ‚œÙ[Xİ^[œÚ[ÛœË›İÜ×ÛÚÊˆ		Ù[Xİ
ˆœ›ÛHX›XË™Ù]İÙX—ØÚ]ÛY\ÜØYÙ\Êˆ\™Ù]İÚÙ[—Ú\ÚOˆ™\X]
	ØIË
K\™Ù]ØY\ˆOˆ[
H		ˆ	ÍLIËˆ	ÕÛÈX[HÙXˆÚ]ÛÉËˆ	İH›Û˜XÚÈİ™\›ØY\È\˜X›H›İ[™Y›İHÛ[›[Z]Y]	ÂŠNÂ‚œÙ[Xİ^[œÚ[ÛœË›İÜ×ÛÚÊˆ		Ù[Xİ
ˆœ›ÛHX›XË™Ù]İÙX—ØÚ]ÛY\ÜØYÙ\Ê™\X]
	ØIË
K	Û›İXK\ØÛÜIË[
H		ˆ	ÌŒŒŒÉËˆ	ÕÙXˆÚ]Ù\ÜÚ[Ûˆ\È[˜[Y	Ëˆ	ØHX[›Ü›YY˜]HØÛÜH\È™Y\ÙY˜]\ˆ[ˆ\ÙY\È[ˆ[˜›İ[™YÙ^IÂŠNÂ‚œÙ[Xİ^[œÚ[ÛœË›İÜ×ÛÚÊˆ		Ù[Xİ
ˆœ›ÛHX›XË™Ù]İÙX—ØÚ]ÛY\ÜØYÙ\Ê	ÜÚÜ	Ë™\X]
	Ø‰Ë
K[
H		ˆ	ÌŒŒŒÉËˆ	ÕÙXˆÚ]Ù\ÜÚ[Ûˆ\È[˜[Y	Ëˆ	ØHX[›Ü›YYÚÙ[ˆ\Èİ[™Y\ÙY	ÂŠNÂ‚‹KHÜ[™H\˜X›HÛ[İØ[˜ÙH[™›İ™HHÙZ[[™È^\İËˆHØÛÜH\È\İ[˜İœ›ÛHHÛ™B‹KH\ÙYX›İ™HÛÈHX\›Y\ˆ\ÜÙ\[ÛœÈÙY\Z\ˆİÛˆYÙ]ˆ[ˆ\ÈÜİÜ™\ÎˆH[Z]\ˆ[\‚‹KH\È[\›˜[[™ÛÜœ™XİK^Xİ]X›HH›ÈÛY[Üˆ˜XÚÙ[™›ÛK‚œ™\Ù]›ÛNÂ™È		™XÛ\™H[™^[YÙ\Â˜™YÚ[‚ˆ›Üˆ[™^[ˆK‹ŒÛÜˆ\™›Ü›HX›XË˜ÛÛœİ[YWÛY\ÜØYÚ[™×Ü˜]WÛ[Z]
	İÙX‹\Û‰È™\X]
	ØÉË
KŒ
NÂˆ[™ÛÜÂ™[™		Â‚œÙ]ØØ[›ÛHÙ\šXÙWÜ›ÛNÂœÙ[XİÙ]ØÛÛ™šYÊ	Ü™\]Y\İšİ˜ÛZ[Kœ›ÛIË	ÜÙ\šXÙWÜ›ÛIËYJNÂ‚œÙ[Xİ^[œÚ[ÛœË›İÜ×ÛÚÊˆ		Ù[Xİ
ˆœ›ÛHX›XË™Ù]İÙX—ØÚ]ÛY\ÜØYÙ\Ê™\X]
	ØIË
K™\X]
	ØÉË
K[
H		ˆ	ÍLIËˆ	ÕÛÈX[HÙXˆÚ]ÛÉËˆ	İH\˜X›HÛ][İH™Y\Ù\ÈHÛY[]\È^]\İY]	ÂŠNÂ‚œ™\Ù]›ÛNÂœÙ[Xİ
ˆœ›ÛH^[œÚ[ÛœË™š[š\Ú

NÂœ›Û˜XÚÎ