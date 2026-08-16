# Avenlyo

Avenlyo is an AI Front Office for service businesses. It will handle customer conversations,
capture leads, book appointments, and hand off to people when appropriate.

This repository contains **Phase 0: Foundation Bootstrap** only. It provides the monorepo,
application shells, multi-tenant database foundation, and industry-pack contracts. It does not
include production integrations, billing, RAG ingestion, or industry-specific workflows.

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
The web application and `/health` API endpoint boot without Supabase credentials. Configure
Supabase before using an authenticated route.

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

| Variable                        | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL; required to enable web authentication. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous/publishable key; required with the URL.   |

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

The initial schema migration lives in `supabase/migrations`. With the Supabase CLI and Docker
available, apply it locally from the repository root:

```bash
supabase start
pnpm db:reset
```

Copy the URL and anonymous key reported by `supabase start` to the application environment files.
The migration enables `pgvector`, creates the multi-tenant base tables, and applies row-level
security policies.

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
  web/                 Next.js public site, auth pages, dashboard shell
packages/
  ai/                  Future AI provider contracts
  database/            Supabase client factory and database boundary
  industries/          Extensible industry-pack definitions and starter packs
  integrations/        Future integration contracts
  knowledge/           Future knowledge-domain contracts
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
- The web dashboard uses real Supabase Auth when public Supabase variables are configured. Without
  them it remains a local-only shell so a new checkout can boot immediately.
