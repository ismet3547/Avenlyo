# Avenlyo

Avenlyo is an AI Front Office for service businesses. It will handle customer conversations,
capture leads, book appointments, and hand off to people when appropriate.

This repository contains the Phase 0 foundation, **Phase 1 authenticated onboarding**, **Phase 2
reviewed website knowledge ingestion**, **Phase 3 controlled AI agent testing**, and **Phase 4
inbound voice control**. It
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
