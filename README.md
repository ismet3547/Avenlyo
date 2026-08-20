# Avenlyo

Avenlyo is an AI Front Office for service businesses. It will handle customer conversations,
capture leads, book appointments, and hand off to people when appropriate.

This repository contains the Phase 0 foundation, **Phase 1 authenticated onboarding**, **Phase 2
reviewed website knowledge ingestion**, **Phase 3 controlled AI agent testing**, **Phase 4 inbound
voice control**, **Phase 5 veterinary ezyVet scheduling**, **Phase 6 Google Calendar scheduling**,
**Phase 7 unified SMS and web-chat messaging**, **Phase 12 Stripe billing and prospective usage
metering**, **Phase 13 human handoff operations and the operator inbox**, **Phase 14 production health and
operational observability**, and **Phase 17 billing entitlement enforcement**. It
provides the monorepo, application shells, multi-tenant database foundation, industry-pack
contracts, Supabase authentication, resumable tenant onboarding, and a real tenant-aware dashboard
empty state. It does not include pricing tiers, usage quotas, or overage billing: Avenlyo Core is
the only plan and its usage limits are deliberately unlimited.

## Prerequisites

- Node.js 22 or newer
- pnpm 9 or newer (`corepack enable` can install the pinned pnpm version)
- Docker Desktop and the [Supabase CLI](https://supabase.com/docs/guides/local-development) only if
  you want to run the local database

## Install and run

```bash
pnpm install
pnpm dev
```

The web app starts at `http://localhost:3000` and the API starts at `http://localhost:4000`.
The public web application and `/health` API endpoint boot without Supabase credentials. Configure
Supabase before using sign-up, sign-in, onboarding, or the dashboard.

To run one application:

```bash
pnpm dev:web
pnpm dev:api
```

## Environment variables

Copy the included examples before configuring a Supabase project:

```bash
Copy-Item apps/web/.env.example apps/web/.env.local
Copy-Item apps/api/.env.example apps/api/.env
```

`apps/web/.env.local` accepts these optional values:

| Variable                        | Purpose                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL; required to enable web authentication.                |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous/publishable key; required with the URL.                  |
| `AVENLYO_API_URL`               | Server-only Fastify URL used by the ezyVet management actions.              |
| `OPENAI_API_KEY`                | Optional, server-only; required to publish knowledge or run Agent Test.     |
| `OPENAI_EMBEDDING_MODEL`        | Optional server-only embedding model. Defaults to `text-embedding-3-small`. |
| `OPENAI_AGENT_MODEL`            | Optional server-only Responses model. Defaults to `gpt-5.6`.                |

`apps/api/.env` accepts these values:

| Variable                            | Required                             | Purpose                                                                   |
| ----------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| `API_PORT`                          | No                                   | API listen port. Defaults to `4000`.                                      |
| `API_HOST`                          | No                                   | API listen host. Defaults to `0.0.0.0`.                                   |
| `API_CORS_ORIGIN`                   | No                                   | Browser origin permitted by the API. Defaults to `http://localhost:3000`. |
| `SUPABASE_URL`                      | Authenticated routes / voice runtime | Supabase project URL.                                                     |
| `SUPABASE_ANON_KEY`                 | Only for authenticated API routes    | Supabase anonymous/publishable key.                                       |
| `SUPABASE_SERVICE_ROLE_KEY`         | Trusted inbound voice runtime only   | Backend-only service role; never use it in Next.js or a browser.          |
| `OPENAI_API_KEY`                    | Trusted inbound voice runtime only   | Backend-only API key for Realtime call control and embeddings.            |
| `OPENAI_WEBHOOK_SECRET`             | Trusted inbound voice runtime only   | OpenAI webhook secret (`whsec_...`) used for raw-body signature checks.   |
| `OPENAI_REALTIME_MODEL`             | No                                   | Server-only Realtime model. Defaults to `gpt-realtime-2.1`.               |
| `OPENAI_PROJECT_ID`                 | No                                   | Optional server-only OpenAI project ID (`proj_...`).                      |
| `EZYVET_PARTNER_ID`                 | ezyVet scheduling                    | Server-only ezyVet partner identifier; enables the trusted connector.     |
| `TWILIO_ACCOUNT_SID`                | SMS webhook/outbound delivery        | Avenlyo-owned Twilio Account SID; never browser-exposed.                  |
| `TWILIO_AUTH_TOKEN`                 | SMS webhook/outbound delivery        | Server-only Twilio token used only by the official Twilio SDK.            |
| `TWILIO_MESSAGING_WEBHOOK_BASE_URL` | SMS webhook/outbound delivery        | Exact public API base used to validate webhook signatures/callbacks.      |
| `OPENAI_AGENT_MODEL`                | No                                   | Text-agent Responses model. Defaults to `gpt-5.6`.                        |
| `STRIPE_MODE`                       | Stripe Billing                       | `test` or `live`; must match the Stripe secret-key mode.                  |
| `STRIPE_SECRET_KEY`                 | Stripe Billing                       | Server-only Stripe SDK secret key; never expose to a browser.             |
| `STRIPE_WEBHOOK_SECRET`             | Stripe Billing                       | Server-only Stripe endpoint signing secret (`whsec_...`).                 |
| `STRIPE_PRODUCT_CORE`               | Stripe Billing                       | Allowlisted Stripe Product ID for source-controlled Avenlyo Core.         |
| `STRIPE_PRICE_CORE_MONTHLY`         | Stripe Billing                       | Allowlisted Stripe monthly Price ID for Avenlyo Core.                     |

Never commit actual `.env` or `.env.local` files. The API validates its environment once at
startup; the web app validates its public configuration once when loaded.

## Local Supabase

Versioned schema migrations live in `supabase/migrations`. With the Supabase CLI and Docker
available, apply it locally from the repository root:

```bash
supabase start
pnpm db:reset
```

Copy the URL and anonymous key reported by `supabase start` to the application environment files.
The migrations enable `pgvector`, create the multi-tenant base tables, apply row-level security,
and add the Phase 1 onboarding state and transactional tenant-bootstrap RPCs.

Database authorization and tenant-integrity behavior is exercised by pgTAP tests in
`supabase/tests/database`:

```bash
pnpm db:test
```

These tests require a running local Supabase stack and execute real PostgreSQL RLS and constraint
checks. The Vitest suite also performs lightweight migration-definition checks, but those checks
only verify that required SQL structures are present; they do not execute PostgreSQL behavior.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Repository layout

```text
apps/
  api/                 Fastify API and HTTP boundary
  web/                 Next.js public site, auth, onboarding, and tenant dashboard
packages/
  ai/                  Controlled agent runtime, provider adapter, tool contracts, and tests
  database/            Supabase client factory and database boundary
  industries/          Extensible industry-pack definitions and starter packs
  integrations/        Future integration contracts
  knowledge/           Secure crawler, chunking, embedding, import, and retrieval contracts
  messaging/           Future messaging-domain contracts
  shared/              Cross-runtime utilities, including environment validation
  ui/                  Shared UI utilities
  voice/               Provider-neutral live-call domain contracts and tests
supabase/migrations/   Versioned PostgreSQL schema and RLS policies
```

## Architecture notes

- The tenant boundary is `organizations`; operational resources also carry `location_id` where a
  location context applies.
- Supabase Auth owns credentials. `public.users` is the application profile keyed to
  `auth.users.id`; `organization_members` grants tenant access.
- `organization_members` stores one organization role per user. Location restrictions for normal
  members live in `organization_member_locations`; owners and admins are organization-wide.
- Rows with `location_id = null` are organization-wide and readable by organization members, but
  normal members may only create or move operational rows within their assigned locations.
- RLS grants location-authorized members operational read/write access, reserves configuration and
  deletion for owners/admins, and keeps action logs client-read-only. Trusted service-role writes
  remain an explicit backend responsibility.
- Composite tenant foreign keys reject cross-organization references. The global-or-tenant industry
  template relationship uses a validation trigger because a composite foreign key cannot express
  "system template or same organization" semantics.
- Industry differences live in `@avenlyo/industries` packs rather than scattered conditionals.
- Workspace bootstrap is a security-definer PostgreSQL function that derives the owner from
  `auth.uid()` and atomically creates the organization, owner membership, primary location, and
  resumable onboarding record.
- Onboarding progress is database-backed. Server-side routing resumes the persisted step and RLS
  remains the authority for every tenant mutation.
- The web dashboard uses real Supabase Auth and reads organization/location context from a trusted
  RPC. Without public Supabase variables, only public pages boot; protected routes return users to
  sign-in.

## Unified messaging (Phase 7)

Phase 7 adds a single tenant-aware conversation model for inbound SMS and hosted web chat. The
existing controlled agent core, approved knowledge retrieval, safety escalation, scheduling state
machine, and human-handoff semantics are reused by transport adapters; there is no separate SMS or
web-chat agent. Each inbound message creates at most one durable `message_processing_jobs` row.
Workers claim work with `FOR UPDATE SKIP LOCKED`, reclaim stale claims, and check for a persisted AI
reply before calling the model again. An AI reply is unique per inbound message.

`conversations.ai_mode` is either `ai` or `human`. A handoff or staff takeover switches to `human`
immediately, so new inbound jobs do not send automatic replies. Staff can reply and later resume
AI from **Dashboard -> Inbox**; resuming itself does not create a message.

### SMS setup

Set the three `TWILIO_*` variables only in `apps/api/.env`. Configure Twilio to send incoming
messages to:

```text
POST https://your-api.example/v1/webhooks/twilio/messaging/inbound
```

Every callback is verified with Twilio's maintained Node SDK against the exact configured base URL
and every submitted form field. The endpoint returns empty TwiML only after durable routing by a
configured, globally unique SMS-enabled DID. Unknown DIDs leave no tenant state. `MessageSid` is
idempotent, media is stored as metadata only, and STOP/START/HELP are deterministic provider
keyword fallbacks. Outbound staff/AI SMS uses the trusted conversation contact and assigned DID;
it cannot take a destination from a model or browser request. If a provider submission is ambiguous,
the delivery is marked `unknown` and is never blindly resent. Status callbacks update delivery state
monotonically.

Twilio resources, phone-number purchase, and real credentialed smoke tests remain manual operations.
No automated test sends an SMS.

### Web chat setup

Owners/admins configure **AI Front Office -> Website Chat** for a location: enable it, list exact
HTTPS origins (with `http://localhost:<port>` allowed only for development), then copy the generated
script tag. The script first creates a browser-origin-validated session, then hosts the UI in an
Avenlyo iframe. Visitors receive an opaque 256-bit token stored only as a SHA-256 hash and refreshed
for 24 hours of inactivity. The browser never receives a Supabase token, service-role key, provider
credential, or raw embedding. Messages are plain text (2,000 characters), use client UUID
idempotency, and poll at a bounded three-second interval.

Anonymous web chat can create a conversation without inventing a verified contact. A scheduling
adapter must therefore require a trusted identity before an ezyVet write; it should hand off instead
of fabricating a contact or pet. Google Calendar remains able to use the existing approved local
booking model where its connector does not require that external identity.

## Production health and operations (Phase 14)

Phase 14 makes the system operable. It adds no customer-facing behaviour: no new AI tool, lead rule,
reminder policy, handoff workflow, or scheduling policy, and human ownership stays exactly as
Phase 13 defined it. Billing enforcement arrived separately, in Phase 17.

**Health endpoints.** `GET /health/live` proves the process is serving HTTP and touches nothing else;
`GET /health` remains a liveness alias so existing probes keep their original meaning.
`GET /health/ready` answers whether this replica can take production traffic, and validates local
facts only — configuration completeness, database reachability through one cheap probe, schema
compatibility, worker scheduler state, and whether the process is draining. It never pings OpenAI,
Twilio, Google, ezyVet, or Stripe, because a provider outage must not turn every replica into a
client hammering that provider on every load-balancer check. Provider execution truth lives in the
durable queues and is read through `ops:status`, not through a health check.

**Schema compatibility.** The database advertises a version through `platform_schema_contract`, and
the application requires at least version 16. Readiness fails when the deployed schema is older than
the running build needs, and deliberately accepts a newer additive schema so an application rollback
can still serve.

**Configuration diagnostics.** Every runtime capability is classified `configured`, `disabled`, or
`partial` from one source-controlled catalogue, which the existing runtime flags now derive from
rather than duplicating. A capability nobody configured is `disabled` and never blocks readiness. A
half-configured one is `partial` and does block it: half a Twilio or Stripe boundary is not a
disabled provider, it is a deployment that will fail somewhere later. Capability names are reported;
setting names and values never are.

**Structured logs.** The existing Fastify/Pino logger gains production configuration rather than a
second framework. Every request carries a server-generated correlation identifier, returned as
`X-Request-Id`; a client-supplied identifier is never adopted as the internal one. Completion lines
record request id, method, normalized route, status, and duration. The raw URL is never logged
because query strings carry web-chat tokens and provider identifiers, and request and response bodies
are never logged at all. Authorization, cookies, and every provider signature header are redacted.
Provider errors are reduced to a bounded set of codes so an SDK message cannot leak a URL or an
identifier into production logs.

**Runtime heartbeats.** Each process registers an ephemeral instance identifier and writes a bounded
heartbeat about every 25 seconds per component, never one per queue item. Several replicas reporting
at once is expected: durable claim and idempotency semantics, not process identity, decide who may do
work, so there is no leader election. A tick that finds no work is a successful tick. Failures record
a short bounded error code and a consecutive-failure count, never a stack trace, payload, or customer
value. Stopped instances are pruned after two days and silent ones after seven; a recently silent
instance is kept, because silence is itself the diagnosis.

**Operational snapshot.** One service-role-only RPC returns global aggregates in a long format a
future exporter can consume without a schema change: message jobs, SMS delivery states, reminders,
lead follow-ups, Stripe webhook events, and ambiguous booking states. Work scheduled for the future is
reported separately from work that is due, so tomorrow's reminder is never counted as backlog. There
is no tenant identifier, contact, phone number, message body, transcript, or provider identifier in
it, and reading it never advances a state machine.

**Operator tooling.** `pnpm ops:status` (optionally `--json`) prints the capability doctor, runtime
heartbeats, and durable aggregates. It is a CLI rather than an HTTP route because Avenlyo has tenant
authorization and no platform-staff role system, and a hidden super-admin page would be pretending to
have security that does not exist. `pnpm smoke:production` checks a deployment's public health
endpoints only — no credential, no tenant mutation, no provider write.

**Graceful shutdown.** `SIGTERM` and `SIGINT` mark the replica not-ready first so the load balancer
drains it while it can still finish accepted work, then stop worker claims, await in-flight ticks,
drain HTTP, and write a final stopped heartbeat. A second signal joins the first sequence instead of
duplicating cleanup or a provider mutation. A failed listen still stops worker runtimes, so no
orphaned timer loop survives.

See [`docs/production-runbook.md`](docs/production-runbook.md) for the deployment order, deployment
checklist, and the response procedures for a database outage, a message-job backlog, an unknown SMS
delivery, a `provider_state_unknown` booking, and a Stripe webhook backlog.

## Human handoff operations (Phase 13)

Phase 13 turns the durable handoffs Phase 3, 4, 7, 10, and 11 already create into an operational
queue at **Dashboard -> Inbox**. The product rule is "AI when it can, human when it should": once a
person owns an escalation, automation must not silently compete with them.

**One active episode per conversation.** A customer conversation may hold at most one unresolved
handoff (`open` or `acknowledged`). That is a partial unique index plus a per-conversation advisory
lock inside `persist_active_conversation_handoff`, which every AI, deterministic, and voice creation
path now calls. A replayed tool call, a second tool call in the same turn, and a later inbound
request all reuse the same durable row. Test-mode agent handoffs stay outside this rule and outside
the production queue.

**Source identity comes from the runtime, never the model.** Text escalations bind the trusted
inbound message in `handoffs.source_message_id`; voice escalations keep the Phase 4
`handoffs.call_id` binding rather than gaining a second competing column. Both are constrained to
the same organization, location, and conversation by composite foreign keys and by a trigger that
also covers the null-location case and keeps the binding immutable.

**Urgency is monotonic.** A later urgent signal escalates the episode already in the queue and
stamps `last_escalated_at`; nothing downgrades urgent work, including through direct SQL. The
original `reason` is never rewritten and no generated reason history accumulates.

**Ownership is a database transaction.** `claim_my_handoff`, `release_my_handoff`, and
`resolve_my_handoff` are the only staff mutation paths, and manual takeover and human reply reuse
the same `apply_handoff_claim` transition rather than maintaining a second assignment path. Two
operators claiming concurrently produce exactly one owner; the loser receives `already_claimed` with
a safe display name for a UI refresh. A replayed claim is an idempotent success that does not
rewrite `first_acknowledged_at` or write a second audit. A normal member cannot take, reply over, or
resolve a handoff a teammate owns. An owner/admin can release an abandoned handoff so another
operator can claim it; releasing keeps the historical first acknowledgement and leaves the
conversation in human mode.

**Resolve is not resume.** Resolving ends the human escalation episode and deliberately leaves
`conversations.ai_mode = 'human'`. `resume_my_conversation_ai` is a separate explicit action that
refuses while an episode is still active (`resolve_handoff_first`), respects conversation ownership,
and does not synthesise a reply: automation becomes eligible again only on the next inbound customer
turn.

**Automation stops competing.** `persist_ai_message_reply` re-checks ownership immediately before it
persists, so a claim that lands after the model call still wins. A queued automated SMS that has not
crossed the provider boundary is suppressed at `claim_sms_delivery_submission` with
`human_ownership_suppressed`. Anything already submitted keeps its provider truth: handoff lifecycle
never rewrites `submitted`, `sent`, `delivered`, `unknown`, `failed`, or `undelivered` history.

**Waiting state is derived, not tracked.** There is no unread system. `customer_waiting` is true when
a customer turn is newer than the newest human-authored reply, and `waiting_since` is the oldest
still-unanswered turn in the current episode. AI replies do not count as human handling. The UI
shows elapsed time only; Phase 13 invents no service-level thresholds.

**Queue order is operational attention.** Urgent waiting work, then urgent, then normal waiting,
then normal, then human-owned conversations with a waiting customer, then remaining recent
conversations. Inside a band the oldest waiting or oldest escalation comes first. Filters are
Urgent, Needs attention, Mine, All active, and Resolved history, and one `get_my_handoff_queue` call
returns every field a row needs, so the inbox does not fan out per-conversation RPCs. Voice
escalations appear in the same queue with their reason, urgency, and current call state.

**Claiming a voice handoff is ownership, not audio.** The Direct SIP architecture is untouched, no
browser softphone exists, and no SMS is created because a staff member claimed or resolved a voice
escalation. Phase 11 consent rules remain authoritative.

**Security.** Authenticated clients can read handoffs at their locations and nothing else: the
insert, update, and delete policies are dropped, and `insert, update, delete` is revoked from
`anon`, `authenticated`, and `service_role`. A trigger also refuses direct browser writes to
`conversations.ai_mode` and `conversations.assigned_user_id`. Internal helpers
(`persist_active_conversation_handoff`, `apply_handoff_claim`, `authorize_my_handoff_operation`, the
display-name and waiting helpers, and the trigger functions) are revoked from every role; the
service-role handoff surface stays `request_message_handoff` and `request_inbound_voice_handoff`,
which derive tenant, location, conversation, and source identity from durable state.

**Audit.** `handoff.created`, `handoff.escalated`, `handoff.claimed`, `handoff.released`,
`handoff.resolved`, `conversation.human_takeover`, and `conversation.ai_resumed` carry bounded
metadata only (channel, urgency, transition, recovery scope). Free-text reasons, phone numbers,
message bodies, and transcripts are never logged, and replays do not duplicate lifecycle audits.
The Phase 4 `voice.handoff.requested` event is replaced by the harmonized `handoff.created` audit so
one durable episode produces exactly one creation record.

**Migration normalization.** Phase 0-12 created one handoff per triggering turn or tool call, so a
conversation could already hold several unresolved rows before the uniqueness rule existed. The
migration keeps the oldest active handoff as the canonical episode, carries any urgent sibling
signal onto it first so de-duplication cannot downgrade urgent work, and resolves the superseded
rows with a `superseded_by_migration` audit. No handoff row and no historical attribution is
deleted.

**One ownership lock.** Ownership mutations used to take row locks in two different orders: claim
locked the handoff and then the conversation, while manual takeover and human reply locked the
conversation and then the handoff, which permitted a real two-session deadlock. Every mutation that
can touch active handoff assignment, `conversations.ai_mode`, or `conversations.assigned_user_id`
now calls `lock_conversation_ownership` first, taking the same per-conversation advisory
transaction lock — the key handoff coalescing already used — before any row lock. Handoff-id RPCs
read identity without mutating, derive the trusted conversation, take the lock, re-read the
authoritative rows under row locks, revalidate authorization and ownership, and only then mutate,
so access that changed while a call waited cannot be exercised against stale authority. Deadlock
retry is not control flow, and there is no in-memory coordination.

**Creation pauses automation.** A durable active customer handoff now guarantees
`conversations.ai_mode = 'human'` because `persist_active_conversation_handoff` owns that
invariant for SMS, web chat, deterministic media handling, voice, and any future trusted caller —
no caller has to remember it. Requesting a person never assigns one: `assigned_user_id` stays null
until a claim or manual takeover. The same function also rejects an organization, location, and
conversation that do not form one durable scope, even when no source message or call is bound.
`conversation.human_takeover` is written by one central helper and only when it performs a real
ai → human transition, so handoff replay, urgency escalation, coalescing onto an already-human
conversation, and claim replay add nothing.

**Human ownership beats queued automation.** The send boundary suppresses a queued AI SMS whenever
a person owns the conversation — a manual takeover with no handoff, or a resolved episode whose
conversation is still human-owned, both count, not just an assigned active handoff. Ownership is
deliberately not inferred from `ai_mode` alone, so the intended handoff acknowledgement produced
during the request-human turn still sends while the episode is unclaimed. Anything that already
crossed the provider boundary keeps its provider truth untouched.

**Recovery in the UI.** Operator actions are viewer-capability aware. A normal member sees a
teammate's handoff read-only; an owner or admin is additionally offered Release and Resolve, and
Resume AI on a human-owned conversation with no active episode. Recovery stays Release then Claim:
an owner/admin is never offered Reply or Claim over the current owner, because neither would
transfer ownership honestly. The server remains the authority; the UI only decides what to show.

**Counting ownership once.** The `Mine` filter and the `Assigned to you` count share one SQL
predicate, so a manual takeover with no handoff appears in both, a resolved handoff whose
conversation is still assigned stays counted until release or resume, and a conversation is never
counted twice.

**Concurrency testing.** pgTAP runs one session in one transaction, so a true two-session lock-cycle
test is not possible without adding fragile infrastructure, and none was added. Instead the protocol
is explicit in code, and the suite asserts structurally that every ownership mutation calls
`lock_conversation_ownership` and calls it before its first row lock, alongside exhaustive
state-transition coverage.

**Waiting belongs to an episode.** A conversation carries `human_attention_started_at`: null while
automation owns it, and stamped when a handoff or a manual takeover first pauses automation. A
message handoff anchors on the trusted inbound turn that triggered it, voice anchors on the
escalation itself, and a manual takeover anchors on the latest customer turn that already exists.
Waiting is then the oldest customer turn at or after that anchor which no human-authored reply in
the same episode has answered, so a question automation resolved three weeks ago can never surface
today as the moment the customer started waiting. Claim, release, resolve, and human reply all stay
inside the same episode; only Resume AI clears the anchor, and a later escalation opens a new
episode with its own. The database read model is the single authority for waiting state, and the
TypeScript mirror takes the anchor explicitly rather than scanning unbounded transcript history.

**Ownership acquisition is never audit-invisible.** `conversation.human_takeover` now covers both
shapes: taking an automation-owned conversation (`ai_to_human_owned`) and taking an already-human
unassigned one (`unassigned_to_human_owner`), with `trigger` recording whether it came from a staff
takeover, a human reply, or a handoff. Pausing automation and taking the conversation are one
operation and one audit; a replay by the same owner writes nothing; and claiming an active handoff
stays audited as `handoff.claimed` alone rather than adding a second ownership record.
**Refresh.** The Inbox runs a bounded 12-second client refresh that pauses while the tab is hidden,
and the navigation attention badge is a single tenant- and location-scoped read per dashboard
render. Phase 13 adds no websocket platform, no staff notifications, and no billing enforcement.

## Controlled AI Agent Test

Phase 3 adds **AI Front Office -> Test Agent**, an owner/admin-only internal console. It uses the
official OpenAI Responses API through a server-only adapter. Set `OPENAI_API_KEY` in
`apps/web/.env.local` to enable it; the browser never receives that key or uses service-role
credentials.

- Each provider request sends `store: false`, disables parallel tool calls, and sends the full
  bounded conversation context owned by Avenlyo. The runtime does not use provider conversation
  chaining or `previous_response_id`. During a single tool loop it retains only opaque encrypted
  reasoning continuation in memory; it is never persisted, logged, or shown in the dashboard.
- Prompts are layered from fixed core safety rules, the selected industry pack, trusted business
  configuration, live server time, and bounded history. Website/retrieval text is explicitly
  treated as untrusted reference material.
- The active allowlist contains only `search_business_knowledge` and `request_human_help`.
  Customer lookup, lead creation, appointments, SMS, transfer, voice, and external integrations
  are declared as inactive future contracts and are never exposed to the provider.
- A turn is bounded to 12 recent / 12,000 historical characters, a 4,000-character customer
  message, 500 output tokens, six tool rounds, and eight total tool calls. Provider calls use a
  15-second SDK timeout. Browser-created UUID idempotency keys are scoped to one test
  conversation; the database allows one running turn per conversation and automatically fails an
  abandoned run only after 10 minutes, which is deliberately far beyond the expected bounded run.
- The deterministic industry safety backstops escalate only narrow high-risk cases: veterinary
  emergency or medication-risk descriptions, medspa contraindication/clinical eligibility
  questions, and auto-repair drive-safety concerns. The agent does not diagnose, prescribe, or
  make vehicle-safety assurances.

Agent Test data uses `conversations.mode = 'test'` and owner/admin-only RPCs. Normal members cannot
read or write test conversations, test messages, handoffs, runs, or test-mode audit logs. The RPCs
derive organization and location from authenticated server context; model tool input cannot choose
tenant IDs. Test records are persisted separately for auditability but cannot contact customers,
book appointments, send SMS, transfer calls, or perform any live operation.

Knowledge retrieval still uses only tenant-authorized, published chunks. Draft and archived chunks
are excluded by the database retrieval RPC. The provider receives only the bounded snippets needed
to answer; the dashboard stores and displays source titles/URLs and tool status, never raw provider
responses, embeddings, or raw retrieval chunks. A conservative internal similarity floor of 0.78
filters nearest-but-unreliable matches. If the agent searched but found no reliable source, its final
answer is replaced with a deterministic safe fallback rather than a business-specific assertion.

To test manually after configuring Supabase and OpenAI, complete onboarding as an owner/admin,
publish at least one approved website source, then open **AI Front Office -> Test Agent**. Start a
new test conversation and try a factual question, a request for human help, and an industry safety
scenario. This triggers billable OpenAI API use; it is intentionally not run by the automated suite.

## Business Knowledge

Phase 2 turns a public business website into reviewed, tenant-isolated knowledge. The lifecycle is:

```text
crawl → draft → human review → publish → chunks → embeddings → semantic retrieval
```

Website pages never become retrieval-ready merely because they were crawled. Owners and admins use
the dashboard’s **AI Front Office → Business Knowledge** area to import, include/exclude, edit, and
publish drafts. Members may read permitted tenant information but cannot configure imports, drafts,
or publication. A retrieval test returns source chunks only; it does not generate AI answers.

### Crawler security model

- Only `http` and `https` DNS hostnames on standard ports 80/443 are accepted. Credentials,
  localhost/local names, IP literals, private/special DNS answers, and arbitrary ports are rejected.
- Every request resolves DNS on the server; every returned A/AAAA address must be globally routable.
  The outbound connection is pinned through Node’s request `lookup` callback to a validated answer,
  preserving the original hostname for Host, TLS SNI, and certificate validation.
- Redirects are handled manually (maximum five) and each target passes URL/DNS validation again.
  After the root site is established, redirects outside its registrable domain are rejected before
  their content is fetched.
- Before every HTML request, Avenlyo loads and caches the target origin’s `robots.txt` policy for
  `AvenlyoBot`. Policies are never shared between origins such as `clinic.example` and
  `booking.clinic.example`.
- Each request also has an absolute 8-second wall-clock deadline, so periodic response bytes cannot
  keep a connection alive indefinitely. No browser, JavaScript execution, or TLS-verification
  bypass is used.

### Import limits and embeddings

- Static HTML/XHTML only; scripts, navigation noise, forms, iframes, and raw HTML rendering are
  excluded. JavaScript-rendered sites and PDFs are intentionally unsupported.
- Each import is capped at 20 logical content-page attempts (including the root and unsuccessful,
  short, or non-HTML responses), depth 2, five redirects per request, 8 seconds per request,
  1 MB per response, and 5 MB of aggregate response bodies. The aggregate allowance includes
  HTML, redirect bodies, and `robots.txt`; it is charged as bytes arrive and the crawl queue is
  bounded by the remaining page-attempt capacity.
- The synchronous `KnowledgeImportRunner` is an MVP boundary designed to move to a queue/worker
  later. A failed rescan never removes already published knowledge. Publishing first reserves an
  immutable review snapshot, performs embeddings outside a database transaction, then completes
  atomically. Failed publication returns the import to review; owners/admins can recover a stalled
  reservation after 15 minutes without deleting drafts.
- Publishing uses the server-only OpenAI SDK by default with `text-embedding-3-small` at 1536
  dimensions. Missing OpenAI configuration still permits crawl/review, but publishing and test
  retrieval report a clear unavailable state. No fake production embeddings are generated.

## Authenticated onboarding

After configuring local Supabase, create an account at `http://localhost:3000/auth/sign-up`. The
application follows this persisted flow:

```text
Industry → Business → Location and hours → Website preview → Review → Dashboard
```

Only the three IDs exported by `@avenlyo/industries` are accepted. Website import is intentionally
a preview only, and the dashboard contains empty states rather than fabricated data. A user who
belongs to exactly one workspace is still taken straight there; someone with several chooses one
explicitly (see Team access below).

GitHub Actions runs the full application validation on pull requests to `main`. A separate database
security job starts Supabase, resets all migrations from scratch, and executes the pgTAP suites.

## Team access and workspace selection (Phase 15)

An owner invites staff from **Settings → Team & access**. Avenlyo creates a secure link and shows it
once; nothing is emailed from the product, and the same durable link would work unchanged if a later
phase adds delivery.

```text
Owner creates invitation → copies link → invited person signs in or signs up
→ invitation accepted, bound to their email → membership and location scope applied atomically
```

**The link is a credential.** The token is 32 random bytes generated in the database, and only its
SHA-256 digest is stored, so a database disclosure yields no working links. It expires after seven
days, and it is bound to one normalized email address: a leaked link is useless to anyone who cannot
authenticate as the invited identity. Inviting the same address again revokes the previous link in
the same transaction, so two live links for one person never coexist. A lost link is replaced by
reissuing, never recovered — no read model can return it.

**Roles are unchanged.** Owner, admin, member. An owner may invite and manage admins and members; an
admin may invite and manage members only, because an admin inviting another admin is self-escalation
by proxy. Nobody is managed into or out of the owner role: ownership transfer is a deliberate future
workflow, and until it exists every organization keeps at least one owner by database constraint.

**Removing access is soft and immediate.** `action_logs`, `handoffs`, and appointment intents all
carry foreign keys to the membership row, so deleting it would erase who actually did that work. The
row stays and is marked revoked; location assignments are cleared. Every authorization helper counts
active membership only, so the next request is refused — no sign-out, no token refresh. Nothing is
auto-resolved and the AI is never resumed: work the person was holding stays assigned to them until
an owner or admin uses **Release** in the Inbox and another teammate **Claims** it.

**Selection is a preference, never authority.** The chosen workspace lives in an HttpOnly cookie that
holds only a context key — no role, because a role can change. Every request revalidates the
selection against current membership, so a revoked membership or an unassigned location simply stops
matching and the user re-resolves. A single-workspace account never sees a selector.

Team mutations go through narrow authenticated RPCs. Direct client insert, update, and delete on
`organization_members` and `organization_member_locations` were withdrawn in this phase, so the
permission matrix is enforced by PostgreSQL rather than by which button the page renders.

## Billing foundation (Phase 12)

Billing is organization-scoped: one Avenlyo organization maps to one Stripe Customer and expects
at most one current Avenlyo subscription. The only source-controlled plan is **Avenlyo Core**.
Its Stripe Product and monthly Price IDs are allowlisted through the server-only
`STRIPE_PRODUCT_CORE` and `STRIPE_PRICE_CORE_MONTHLY` environment variables; mutable Stripe
metadata is never used as an authorization source. Core usage limits are intentionally unlimited
in this phase.

Owners and admins can open **Dashboard -> Billing** to start a server-created Stripe Checkout
session, manage the stored Customer through Stripe Customer Portal, or refresh provider state. The
browser never provides a Stripe customer, subscription, product, price, or return URL. The fixed
return paths are the Avenlyo billing page. A Checkout success redirect is informational only: a
signed Stripe webhook is durably recorded first and the worker reconciles current provider truth
before local state changes.

Set these values only in `apps/api/.env`:

```dotenv
STRIPE_MODE=test
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRODUCT_CORE=prod_...
STRIPE_PRICE_CORE_MONTHLY=price_...
```

`STRIPE_MODE` must match the secret-key mode. The API rejects test/live webhook mismatches.
Missing billing settings fail billing mutation endpoints closed without affecting Voice, SMS, Web
Chat, reminders, or follow-ups. Stripe hosts Checkout and Portal; Avenlyo stores only provider
references and subscription projection state, never card, payment-method, invoice,
billing-address, raw-webhook, or signature data.

The prospective immutable `billing_usage_events` ledger records answered Voice seconds, outbound
SMS provider-submission attempts, normal SMS/Web AI text turns, and appointments created through a
trusted Avenlyo booking intent. It does not backfill historical events or call Stripe Meter Events.
Phase 12 recorded billing truth without acting on it. **Phase 17 enforces it**: a supported Core
subscription is required before new production customer automation may consume a paid feature.

## Billing entitlement enforcement (Phase 17)

Runtime authorization comes from the last durably applied billing projection, never from a live
Stripe call, a browser, a cookie, a React prop, or a model. `active` and `attention` are entitled —
`past_due` is a recoverable payment problem, not a suspension, and a supported Stripe trial counts.
`inactive`, `review_required`, and `unconfigured` are not; ambiguous or unsupported provider
topology fails closed rather than being read optimistically.

Entitlement is evaluated at the durable execution claim, so an operation already claimed while
entitled finishes, and once entitlement is gone no new claim reaches OpenAI, Twilio, Google
Calendar, or ezyVet. Blocked work terminates deliberately with the bounded reason
`billing_unavailable` and is never replayed, so restoring billing releases no backlog of old
replies, reminders, or follow-ups.

Suspension is not a lockout. Customer history stays readable, inbound SMS is still received and
persisted, STOP still takes effect, operators keep claiming and resolving conversations, and owner
configuration is never rewritten — a paused Voice number still reads as enabled, because it is.
Trusted service-role identity proves a worker may do backend work; it is never an entitlement
bypass. The Phase 3 test agent, onboarding, knowledge configuration, and team management stay
usable without a subscription.

## Inbound Voice (Phase 4)

Phase 4 is inbound-only. The call media path is deliberately direct and Avenlyo never proxies RTP
or stores raw audio:

```text
PSTN -> Twilio Elastic SIP Trunk -> OpenAI Realtime SIP
                                      <-> Avenlyo Fastify sideband control
                                          -> approved tools / tenant database
```

The Fastify endpoint `POST /webhooks/openai/realtime` preserves the raw JSON body, verifies the
official OpenAI webhook signature before parsing it, then handles only `realtime.call.incoming`.
Twilio Elastic SIP routing uses the original called DID in the SIP `Diversion` header; it never
trusts `To`, `From`, arbitrary headers, browser input, or model input to select a tenant. The
number must be a globally unique canonical E.164 Twilio assignment.

The sideband session uses the server-only `OPENAI_REALTIME_MODEL=gpt-realtime-2.1` setting with
OpenAI Server VAD (`interrupt_response: true`), final input/audio transcript events, and a 30-minute
server-enforced maximum call duration. It persists only final caller and assistant transcripts as
tenant conversation messages. It does not persist audio, partial transcript deltas, or provider
secrets. The active tool allowlist is `search_business_knowledge`, `request_human_help`, and,
only when trusted configuration and trunk capability permit it, `transfer_call`. The model never
sees a transfer number; it can provide only a reason and the backend resolves the configured E.164
destination before using SIP REFER.

### Operational setup (manual in this phase)

This repository does not provision Twilio resources or purchase phone numbers. Configure the alpha
path manually:

1. In OpenAI, create/configure a project, set its incoming Realtime-call webhook to the public
   Fastify URL, and store its `whsec_...` value only in `apps/api/.env`.
2. In Twilio, create an Elastic SIP Trunk and configure its secure TLS origination URI for the
   OpenAI project. Attach the selected Twilio phone number. If human transfer is required, enable
   the relevant SIP REFER/PSTN transfer behavior on that trunk.
3. Apply the Avenlyo migrations, then assign the DID from an operations shell, never from a browser:

   ```bash
   pnpm --filter @avenlyo/api voice:assign-number --organization <organization-uuid> --location <location-uuid> --number +14155550123 --label "Main line"
   ```

4. As an owner/admin, open **AI Front Office -> Inbound Voice**, choose a built-in voice, enable
   the channel, and optionally save a trusted human transfer number. The dashboard cannot claim or
   reassign a provider number. Operations must separately attest the trunk's transfer capability;
   until then the transfer tool is not exposed to the model. After validating the trunk, use the
   separate trusted operations command:

   ```bash
   pnpm --filter @avenlyo/api voice:set-transfer-capability --organization <organization-uuid> --location <location-uuid> --enabled true
   ```

For a real-phone smoke test, call the assigned number, confirm the short Avenlyo AI greeting, ask a
published knowledge question, interrupt it while speaking, ask for human help, and review the call
and final transcript records. Try an unsupported booking request: the agent must not invent
availability and should offer a human handoff. For a veterinary safety check such as “My dog ate
chocolate and is shaking,” it must not diagnose or give dosage advice; it should create an urgent
human handoff, and only perform a transfer if one is explicitly configured and operational.

The Phase 4 session manager is intentionally in-process. A Fastify process restart ends active
sideband orchestration; the database retains durable call, transcript, handoff, and audit records.
No automated test makes a real OpenAI, Twilio, or phone call.

## Veterinary scheduling (Phase 5)

Phase 5 adds a provider-neutral `BookingConnector` contract and an ezyVet implementation for the
veterinary pack only. It supports catalog sync, vetted appointment type/resource policy, live
availability, exact existing-contact/pet resolution, explicit caller confirmation, and creating a
local appointment record after the provider booking succeeds. It intentionally does not create
contacts or pets, reschedule/cancel appointments, send outbound reminders, or implement another
calendar provider.

Owners and admins configure ezyVet from **Integrations** for one location. The browser submits the
client secret once to the Fastify endpoint; the endpoint verifies the official site information and
stores the credential only with Supabase Vault. Application tables retain a Vault secret ID and
non-sensitive metadata, never OAuth access tokens, client secrets, request bodies, or raw provider
errors. The backend uses fixed official production/trial origins, source-controlled least-privilege
scopes, an in-memory expiry-aware OAuth cache, and an eight-second request deadline. The integration
is disabled unless `EZYVET_PARTNER_ID`, Supabase service-role access, and a connected location are
present.

Inbound veterinary voice adds the constrained tools `get_available_appointments`,
`prepare_appointment_booking`, and `book_appointment` only when this backend integration is
available. Candidate slots expire after 10 minutes. The booking tool requires a final inbound
caller utterance containing explicit confirmation, claims the intent atomically, rechecks the exact
slot immediately before the non-retried provider POST, and then idempotently stores the returned
provider appointment ID locally. Any safety escalation blocks scheduling for the rest of that call.
Timeout or ambiguous provider-write outcomes are retained as `provider_state_unknown` for human
follow-up; the system never falsely tells the caller that a booking succeeded.

To run a manual **trial** verification, apply the migrations, set `EZYVET_PARTNER_ID` only in
`apps/api/.env`, start the API and web applications, then connect a disposable ezyVet trial site as
an owner/admin. Sync the catalog, select one active appointment type and calendar resource, assign
an inbound voice number through the existing Phase 4 operations workflow, and place a call from a
phone number that exactly matches an existing trial contact with a uniquely named pet. Confirm an
offered slot explicitly. Verify the returned appointment in ezyVet and the local Appointments page.
This requires real ezyVet credentials and is therefore not run by CI or this repository's automated
tests.

## Google Calendar scheduling (Phase 6)

Scheduling now has one provider-neutral path:

```text
Voice (and future channels) -> VoiceBookingService -> SchedulingConnectorRegistry
  -> BookingConnector (ezyVet or Google Calendar)
```

Each location has one explicit active scheduling integration. Connected integrations can coexist,
but the runtime never guesses between them. Existing configured ezyVet locations remain selected;
Google Calendar is never selected automatically. Google Calendar is available to veterinary, auto
repair, and medspa locations, while the existing industry handoff protections still block scheduling
after urgent veterinary, clinical-eligibility, or vehicle-safety escalation.

### Google OAuth and credentials

Create an Avenlyo-owned Google OAuth web application and set these **server-only** values in
`apps/api/.env`:

```dotenv
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:4000/v1/scheduling/google-calendar/callback
```

The redirect URI must exactly match the URI registered in Google Cloud Console. The browser only
starts the owner/admin-authorized flow; Fastify creates a random state, stores only its SHA-256 hash
with a 10-minute single-use expiry, exchanges the authorization code server-side, and consumes that
state atomically. It always requests offline access and this fixed minimal scope set:

- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
- `https://www.googleapis.com/auth/calendar.events.freebusy`
- `https://www.googleapis.com/auth/calendar.events`

No Gmail, Contacts, Drive, profile, or email scope is requested. The per-business refresh token is
stored only as a Supabase Vault secret referenced by `integration_credentials`; access tokens are
memory-only and expire from the bounded cache. A reconnect updates the existing Vault secret and
increments its credential version. If Google omits a refresh token, a valid existing token is kept;
a first-time connection without one is rejected.

### Calendar policy and availability

Calendar discovery reads calendar-list metadata only. Only calendars with Google effective
`writer` or `owner` access can become scheduling resources; primary calendars are not automatically
bookable. Owners/admins explicitly choose resources, create Avenlyo-managed appointment types
(10–360 minutes in 5-minute increments), map types to resources, configure minimum lead time
(default 60 minutes), and select the active provider.

For Google, availability is a trusted intersection of location business hours, IANA timezone,
minimum lead, and Google FreeBusy ranges. It uses a 14-day horizon, 15-minute local grid, at most
five resources and five model-facing candidates. Busy ranges are merged as `[start, end)` and a
full appointment duration must fit. Candidates still expire after ten minutes.
Every selected calendar must be present in the FreeBusy response with no calendar-level error;
missing, malformed, or partial Google responses fail closed and produce no candidates. Nonexistent
spring-forward wall times are skipped. For fall-back ambiguity Avenlyo uses the earlier occurrence,
then defensively removes duplicate provider/resource/type intervals before limiting results.

Before the one permitted Google event write, Avenlyo claims a short PostgreSQL exclusion lease for
the resource/interval and rechecks FreeBusy. This prevents two Avenlyo callers from writing the
same calendar interval without holding a database transaction open over Google network calls.
The active integration, connected status, type/resource bookability, and Google type-to-resource
mapping are checked again before a first provider write. A later configuration change therefore
requires fresh availability and cannot post a stale candidate.

### Booking and recovery

`prepare_appointment_booking` accepts only an offered candidate and optional subject context. ezyVet
continues to require exact external Contact/Animal resolution. Google Calendar uses trusted local
caller/contact context and never invents a Google customer, pet, or vehicle ID. A later explicit
customer confirmation is still required before any provider write.

Google events are normal single events only: no attendees, invitations, Meet links, recurrence,
reminders, updates, cancellation, or webhooks. Their deterministic lower-case hexadecimal ID is
derived from the booking-intent UUID. Private extended properties contain only the booking-intent
and integration IDs. `events.insert` is never blindly retried: a timeout, network error, 5xx, or
409 triggers one bounded `events.get` reconciliation of that exact ID, calendar, interval, and
private marker. A mismatch is treated as a safe conflict for human follow-up, never overwritten.
Cancelled events and marker mismatches are never reconciled as successful bookings. Once provider
success is durably recorded, its normalized provider status is retained for local persistence and
recovery remains tied to the historical intent/integration even if an administrator later switches
providers, disables the integration, or disables its catalog rows.

### Manual Google validation

Automated tests never call Google. With disposable Google OAuth credentials, connect a test account
from **Dashboard -> Integrations**, select a dedicated writer/owner calendar, create and map a
30-minute type, set business hours, then complete a voice booking with a later explicit confirmation.
Verify one event with the expected timezone, interval, and private metadata, one local appointment,
and that a separately-created busy event removes the slot. This manual check is not run without test
credentials.

## Appointment reminders (Phase 8)

Phase 8 adds deterministic SMS appointment reminders. They are disabled by default and may be
configured only by an organization owner or admin at **Dashboard -> Appointments -> Manage
appointment reminders**. Enabling SMS requires an active SMS-enabled business DID for that
location. Each location may enable the 24-hour and/or 2-hour schedule and uses quiet hours of
20:00â€“08:00 in its IANA timezone by default.

A nominal reminder outside quiet hours is unchanged. If it falls inside quiet hours, Avenlyo moves
it to the closest earlier permitted local instant and schedules it only if it remains in the useful
window: 26â€“18 hours before for a 24-hour reminder, and 150â€“75 minutes before for a 2-hour
reminder. It is never deferred later, never moved to or after the appointment, and is omitted when
the earlier boundary would fall in a spring-forward gap or outside its useful window. For an
ambiguous fall-back boundary, PostgreSQL's standard-time (later UTC) interpretation is used only
when it is still strictly earlier than the nominal instant; otherwise the reminder is omitted.

The database creates at most one durable reminder per appointment and reminder type, only for a
confirmed future appointment within a 30-day horizon. The worker claims due rows atomically with
`FOR UPDATE SKIP LOCKED`; every fresh claim resets revalidation and a crashed claim is recoverable
after five minutes. A bounded reconciliation batch runs before claims, so appointments entering the
30-day horizon and pending timing-policy changes are picked up without an unbounded settings
transaction. Cancelled, completed, disabled, or unverified appointments are skipped.

The booking-time verified SMS recipient is copied onto the appointment/reminder as a write-once
snapshot and is the only destination used for deliveryâ€”later edits to a contact do not retarget the
message. Appointments without that verified recipient are safely skipped. Existing per-location
sender opt-out policy is checked again before materializing and before submitting SMS. Materializing
a message produces `delivery_pending`, not `sent`: the existing Phase 7 Twilio delivery state
machine is authoritative. Only `sent`/`delivered` marks a reminder sent; suppression skips it, and
failed, undelivered, or unknown delivery outcomes mark it failed. This includes a legitimate
Phase 7 sent-to-undelivered callback; a terminal `delivered` callback cannot later be changed
to undelivered by the delivery transition graph. No delivery transition retries a provider
submission blindly.

Immediately before the single Phase 7 queued-to-submitting authorization, the database checks
the exact 24-hour/2-hour toggle, current schedule version, current appointment time, quiet-hour
calculation, active sender, and opt-out state. A materialized reminder is suppressed rather than
sent if any of these changed. A no-op settings save leaves the schedule version unchanged. Bounded
reconciliation considers only scheduled rows and recoverable configuration skips as policy-stale,
so terminal provider, delivery, opt-out, and elapsed-window outcomes cannot starve later eligible
appointments.

For Google Calendar and ezyVet appointments, the worker performs only the existing bounded
read/reconciliation path immediately before creating the local reminder message. A disconnected,
unavailable, missing, cancelled, or non-exact provider record is skipped. The reminder worker never
calls `createBooking`, updates a provider appointment, or invokes OpenAI. A confirmed local
appointment without an external provider identity does not require provider revalidation.

### Manual reminder validation

In a disposable environment, configure an active SMS-enabled business DID, create a confirmed
appointment 23 hours in the future through the approved booking flow, then enable the 24-hour
schedule for its location. Confirm one `appointment_reminders` row is claimed, one deterministic
outbound SMS message/delivery is created with `delivery_pending`, and the destination remains the
booking-time phone after editing the contact phone. Confirm that only a Twilio `sent` or `delivered`
callback marks the reminder sent. Repeat after a customer sends `STOP` before the delivery claim:
the delivery must be suppressed and no provider submission should occur. Disable the scheduling
integration or cancel the appointment before its reminder is due: no SMS should be created.
Automated tests do not post a real SMS or query real provider accounts.
