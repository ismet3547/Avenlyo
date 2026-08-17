# Avenlyo

Avenlyo is an AI Front Office for service businesses. It will handle customer conversations,
capture leads, book appointments, and hand off to people when appropriate.

This repository contains the Phase 0 foundation, **Phase 1 authenticated onboarding**, **Phase 2
reviewed website knowledge ingestion**, **Phase 3 controlled AI agent testing**, **Phase 4 inbound
voice control**, **Phase 5 veterinary ezyVet scheduling**, **Phase 6 Google Calendar scheduling**,
and **Phase 7 unified SMS and web-chat messaging**. It
provides the monorepo, application shells, multi-tenant database foundation, industry-pack
contracts, Supabase authentication, resumable tenant onboarding, and a real tenant-aware dashboard
empty state. It does not include production integrations, billing, live customer AI, or AI workflows.

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
| `AVENLYO_API_URL`               | Server-only Fastify URL used by the ezyVet management actions.               |
| `OPENAI_API_KEY`                | Optional, server-only; required to publish knowledge or run Agent Test.     |
| `OPENAI_EMBEDDING_MODEL`        | Optional server-only embedding model. Defaults to `text-embedding-3-small`. |
| `OPENAI_AGENT_MODEL`            | Optional server-only Responses model. Defaults to `gpt-5.6`.                |

`apps/api/.env` accepts these values:

| Variable                    | Required                             | Purpose                                                                   |
| --------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| `API_PORT`                  | No                                   | API listen port. Defaults to `4000`.                                      |
| `API_HOST`                  | No                                   | API listen host. Defaults to `0.0.0.0`.                                   |
| `API_CORS_ORIGIN`           | No                                   | Browser origin permitted by the API. Defaults to `http://localhost:3000`. |
| `SUPABASE_URL`              | Authenticated routes / voice runtime | Supabase project URL.                                                     |
| `SUPABASE_ANON_KEY`         | Only for authenticated API routes    | Supabase anonymous/publishable key.                                       |
| `SUPABASE_SERVICE_ROLE_KEY` | Trusted inbound voice runtime only   | Backend-only service role; never use it in Next.js or a browser.          |
| `OPENAI_API_KEY`            | Trusted inbound voice runtime only   | Backend-only API key for Realtime call control and embeddings.            |
| `OPENAI_WEBHOOK_SECRET`     | Trusted inbound voice runtime only   | OpenAI webhook secret (`whsec_...`) used for raw-body signature checks.   |
| `OPENAI_REALTIME_MODEL`     | No                                   | Server-only Realtime model. Defaults to `gpt-realtime-2.1`.               |
| `OPENAI_PROJECT_ID`         | No                                   | Optional server-only OpenAI project ID (`proj_...`).                      |
| `EZYVET_PARTNER_ID`         | ezyVet scheduling                    | Server-only ezyVet partner identifier; enables the trusted connector.    |
| `TWILIO_ACCOUNT_SID`        | SMS webhook/outbound delivery         | Avenlyo-owned Twilio Account SID; never browser-exposed.                 |
| `TWILIO_AUTH_TOKEN`         | SMS webhook/outbound delivery         | Server-only Twilio token used only by the official Twilio SDK.           |
| `TWILIO_MESSAGING_WEBHOOK_BASE_URL` | SMS webhook/outbound delivery | Exact public API base used to validate webhook signatures/callbacks.     |
| `OPENAI_AGENT_MODEL`        | No                                   | Text-agent Responses model. Defaults to `gpt-5.6`.                       |

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
a preview only, and the dashboard contains empty states rather than fabricated data. The current
MVP automatically selects the tenant when a user belongs to exactly one organization; a future
organization switcher is outside Phase 1.

GitHub Actions runs the full application validation on pull requests to `main`. A separate database
security job starts Supabase, resets all migrations from scratch, and executes the pgTAP suites.

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
