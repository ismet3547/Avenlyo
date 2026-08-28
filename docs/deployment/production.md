# Avenlyo production deployment

> **PRODUCTION HAS NOT BEEN DEPLOYED BY PHASE 20.**
>
> No production VM exists. No DNS record has been created. No Supabase project has been provisioned.
> No provider account has been switched to live mode. No credential has been issued or configured.
> Nothing described below has been executed.
>
> This document is the deployment contract: what production will need, and what has been proven
> ahead of time. It is not a record that any of it happened.

## What Phase 20 actually established

The claim is narrow, so it is worth stating exactly:

- A production deployment is **described**, and its configuration is **validated by code and proven
  in CI** for both targets from the same source.
- Production is **not deployed**, **not reachable**, and **not verified against anything running**.

The gap between those two is the entire remaining go-live work, listed at the bottom.

## One topology, two environments

Staging and production run the **same** `deploy/compose.yaml` and the **same** `deploy/Caddyfile`.
There is no second stack.

This is a deliberate rejection of the more common arrangement, where production gets its own copy of
the deployment files. Two copies drift, the drift is invisible, and it is discovered in production —
which is the one environment where discovering it is expensive. One topology means the security
properties verified in staging are the same properties production has, rather than properties
production is assumed to have.

So the only thing that differs between the two environments is **public hostname data**, plus the
credentials that necessarily point at different accounts. `.github/scripts/assert-deployment-profile.mjs`
renders both profiles through the real `docker compose config` in CI and asserts that this is true —
and CI then injects a cross-wired hostname and a merged network to prove the assertion actually
catches the defect rather than merely existing.

| | Staging | Production |
| --- | --- | --- |
| Web hostname | `staging.avenlyo.com` | `avenlyo.com` |
| API hostname | `api-staging.avenlyo.com` | `api.avenlyo.com` (example — see below) |
| `AVENLYO_DEPLOYMENT_ENV` | `staging` | `production` |
| `NODE_ENV` | `production` | `production` |
| Compose file | `deploy/compose.yaml` | `deploy/compose.yaml` |
| Caddyfile | `deploy/Caddyfile` | `deploy/Caddyfile` |
| Supabase project | staging project | a separate project, not yet provisioned |
| Stripe mode | `test` | `live` |

`avenlyo.com` is the settled production web domain. **`api.avenlyo.com` is an example**: it is
deployment configuration, not a claim that the record exists or that the name has been decided.

`NODE_ENV` is `production` in both on purpose, so staging exercises production runtime behaviour.
That is precisely why `AVENLYO_DEPLOYMENT_ENV` exists — see the runbook.

## Configuration

`deploy/env/production.public.env.example` carries the non-secret, environment-differing values, and
nothing else. Every secret keeps its single home in the existing templates (`build.env.example`,
`web.env.example`, `api.env.example`), because a second copy of a secret template is a second thing
to keep in sync and the copy that drifts is always the one nobody reads.

Nothing in `production.public.env.example` is a secret, and nothing in it may ever become one.

### Values that must change for production

Beyond the hostnames above:

- `AVENLYO_DEPLOYMENT_ENV=production`
- `AVENLYO_RELEASE` — the exact 40-character commit SHA
- `AVENLYO_EXPECTED_SUPABASE_PROJECT_REF` — the production project ref. A Supabase URL is opaque and
  says nothing about which environment it belongs to, so production accidentally pointed at the
  staging database is not detectable from the URL alone. Declaring the expected ref is what makes a
  mismatch provable; leaving it unset makes preflight report `unverified` rather than passing.
- `STRIPE_MODE=live`, with live keys and a live webhook secret
- `GOOGLE_OAUTH_REDIRECT_URI` and `TWILIO_MESSAGING_WEBHOOK_BASE_URL` — production URLs, never
  `*-staging.avenlyo.com`

### Values that must **not** change

- `AVENLYO_API_URL=http://caddy:8080` — identical in both environments. It is the internal boundary
  that keeps the API's trusted-proxy hop count at one; see the runbook's topology section.
- Caddy's upstreams. They are literals in the Caddyfile and are not configurable in any environment.

## Validation before deploying

```bash
pnpm ops:preflight
```

Read-only, contacts no provider, writes nothing. It must exit 0. It is the check that catches a
production configuration still carrying a staging hostname, a `test` Stripe key in production, a
release that is not an exact SHA, a mismatched Supabase project, and a CORS origin that has drifted
from the app origin.

Findings name the setting, never its value, so the output is safe to paste into a ticket.

## Go-live work not done by Phase 20

Every item is an infrastructure or account action, outside this repository:

1. Provision the production host.
2. Provision a **separate** production Supabase project. Do not reuse staging.
3. Create the DNS records for the production hostnames.
4. Obtain TLS certificates (Caddy does this via ACME once DNS resolves).
5. Switch Stripe, Twilio, Google, and OpenAI to production accounts and credentials.
6. Populate `/etc/avenlyo/api.env` and `/etc/avenlyo/web.env` on the production host.
7. Configure the external monitoring checks listed in the runbook.
8. Apply migrations to the production database.
9. Run `pnpm ops:preflight` and require exit 0.
10. Build the release images once, tagged with the exact SHA.
11. Deploy with `up -d --no-build`, then run `smoke:production` with `AVENLYO_EXPECTED_RELEASE` set.

Steps 1–7 need credentials and provider access that deliberately do not exist in this repository or
in CI. Nothing in Phase 20 attempts any of them.
