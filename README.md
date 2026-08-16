# Avenlyo

Avenlyo is an AI Front Office for service businesses. It will handle customer conversations,
capture leads, book appointments, and hand off to people when appropriate.

This repository contains the Phase 0 foundation, **Phase 1 authenticated onboarding**, and
**Phase 2 reviewed website knowledge ingestion**. It
provides the monorepo, application shells, multi-tenant database foundation, industry-pack
contracts, Supabase authentication, resumable tenant onboarding, and a real tenant-aware dashboard
empty state. It does not include production integrations, billing, RAG ingestion, or AI workflows.

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

| Variable                        | Purpose                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL; required to enable web authentication.                 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous/publishable key; required with the URL.                   |
| `OPENAI_API_KEY`                | Optional, server-only; required only to publish or test knowledge retrieval. |
| `OPENAI_EMBEDDING_MODEL`        | Optional server-only embedding model. Defaults to `text-embedding-3-small`.  |

`apps/api/.env` accepts these values:

| Variable            | Required                          | Purpose                                                                   |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| `API_PORT`          | No                                | API listen port. Defaults to `4000`.                                      |
| `API_HOST`          | No                                | API listen host. Defaults to `0.0.0.0`.                                   |
| `API_CORS_ORIGIN`   | No                                | Browser origin permitted by the API. Defaults to `http://localhost:3000`. |
| `SUPABASE_URL`      | Only for authenticated API routes | Supabase project URL.                                                     |
| `SUPABASE_ANON_KEY` | Only for authenticated API routes | Supabase anonymous/publishable key.                                       |

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
  ai/                  Future AI provider contracts
  database/            Supabase client factory and database boundary
  industries/          Extensible industry-pack definitions and starter packs
  integrations/        Future integration contracts
  knowledge/           Secure crawler, chunking, embedding, import, and retrieval contracts
  messaging/           Future messaging-domain contracts
  shared/              Cross-runtime utilities, including environment validation
  ui/                  Shared UI utilities
  voice/               Future voice-domain contracts
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
- Crawls stay within the final site’s registrable domain, respect `robots.txt` for `AvenlyoBot`, and
  use no browser, JavaScript execution, or TLS-verification bypass.

### Import limits and embeddings

- Static HTML/XHTML only; scripts, navigation noise, forms, iframes, and raw HTML rendering are
  excluded. JavaScript-rendered sites and PDFs are intentionally unsupported.
- Each import is capped at 20 pages, depth 2, five redirects per request, 8 seconds per request,
  1 MB of HTML per page, and 5 MB total HTML.
- The synchronous `KnowledgeImportRunner` is an MVP boundary designed to move to a queue/worker
  later. A failed rescan never removes already published knowledge.
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
