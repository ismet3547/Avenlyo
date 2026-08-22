# Avenlyo Hetzner staging

Runbook for the production-like staging deployment introduced by this PR. Nothing here has been
executed: no Hetzner VM is provisioned, no DNS record changed, no migration run against hosted
Supabase. This document describes the procedure a human runs manually, later.

```
                          Internet
                             |
                        [ 80 / 443 ]
                             |
                          caddy   (auto TLS, host-based routing)
                     /                     \
      staging.avenlyo.com          api-staging.avenlyo.com
                |                             |
             web:3000                      api:4000
          (next start)          (fastify + in-process messaging,
                                  billing, and knowledge-import
                                  workers + sandboxed Chromium
                                  rendered fallback)
                                             |
                                    hosted Supabase (external,
                                    authoritative -- staging project)
```

`3000` and `4000` exist only on the Docker-internal network defined in `deploy/compose.yaml`.
Caddy is the only process with a published host port.

## Build-time vs. runtime configuration

Two genuinely different kinds of configuration, handled two different ways:

- **Build-time, browser-facing** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_AVENLYO_API_URL`): Next.js compiles these into the client
  JavaScript bundle at `next build` time. Setting them as a container runtime environment variable
  has no effect on an already-built image -- the value has to exist before `docker build` runs.
  They are supplied as Docker build args (`deploy/Dockerfile.web`'s `ARG`s), sourced from
  `deploy/env/build.env` (real values, never committed -- see `deploy/env/build.env.example`).
  They are public values (an anon key scoped by RLS, a base URL) but still never hardcoded into the
  repository, the same way no other deployment-specific configuration is.
- **Runtime, server-only** (everything else): read from `/etc/avenlyo/web.env` and
  `/etc/avenlyo/api.env` on the host via Compose's `env_file:`. Changing one of these does not
  require rebuilding an image, only restarting the container.

## Environment files

Never commit a real env file. Templates only:

| Template | Real path on the host | Contents |
|---|---|---|
| `deploy/env/web.env.example` | `/etc/avenlyo/web.env` | Runtime, server-only web config |
| `deploy/env/api.env.example` | `/etc/avenlyo/api.env` | Runtime, server-only API config |
| `deploy/env/build.env.example` | `deploy/env/build.env` (on whichever machine runs `docker build`) | `NEXT_PUBLIC_*` build args |

Permissions on the host: `0640`, owned by a dedicated `avenlyo` user/group -- never world-readable,
never readable by any container that doesn't need them.

**`SUPABASE_SERVICE_ROLE_KEY` must never appear in `web.env`.** Confirmed by grep against this
repository: no reference to it exists anywhere in `apps/web`. Web only ever uses the anon key plus
the caller's own session (RLS-scoped); the service-role key is API-only.

`AVENLYO_INTERNAL_BILLING_SECRET` must be byte-identical between `web.env` and `api.env`, or every
billing mutation fails closed by design.

## NODE_ENV and Stripe on staging

Staging runs `NODE_ENV=production` -- it exercises production runtime behavior, per the actual
project decision, not the more permissive `NODE_ENV=development` an earlier draft audit of this
repository considered.

Payments are intentionally not configured at this project stage. `apps/api/src/env.ts`'s production
guard only rejects the specific combination `NODE_ENV=production` **and** `STRIPE_MODE=test`:

```ts
if (env.NODE_ENV === 'production' && env.STRIPE_MODE === 'test') {
  throw new Error('STRIPE_MODE must be live in production.');
}
```

Leaving `STRIPE_MODE` and every `STRIPE_*` variable **entirely unset** in `api.env` avoids this
guard without weakening it: the application's own capability system (`isStripeBillingConfigured` in
`apps/api/src/env.ts`) already reports the billing boundary unconfigured when its secrets are
absent, and every billing-dependent code path fails closed exactly as it is designed to. Do not set
fake or placeholder Stripe credentials merely to make staging boot -- it already boots correctly
with none.

## Release identifier

`AVENLYO_RELEASE` is set from the deployed commit SHA, supplied as a shell/CI environment variable
to `docker compose`, not baked into the image or generated per container restart:

```
AVENLYO_RELEASE=$(git rev-parse HEAD) docker compose -f deploy/compose.yaml up -d
```

Both `web` and `api` read the same value (`deploy/compose.yaml`'s `environment:` block for each
service), and it also names the image tag (`avenlyo-api:${AVENLYO_RELEASE}`,
`avenlyo-web:${AVENLYO_RELEASE}`), which is what makes rollback a tag switch rather than a rebuild
(see below).

## Migration deployment order

**Not automated by this PR.** No container startup runs a migration. No `supabase db push` was run
in this implementation session. The order a human follows, later:

1. CI green on the PR that needs the new schema.
2. Take whatever backup/checkpoint the team's standard practice calls for.
3. `supabase link --project-ref <staging-project-ref>` (once), then `supabase db push` against the
   linked **staging** project -- never hosted production, never run from this PR.
4. Verify the new schema version is live (the same `platform_readiness_probe` RPC
   `apps/api/src/routes/health.ts` already calls).
5. Deploy the new containers (see "Deploy procedure" below).
6. Verify API `GET /health/ready` reports `ready`.
7. Verify web `GET /api/health` reports `ok`.

This PR's base branch carries three Phase 18 migrations and requires schema version 18
(`REQUIRED_SCHEMA_VERSION` in `apps/api/src/observability/readiness.ts`). The existing readiness
contract is what makes this safe to sequence exactly this way: `evaluateReadiness` accepts a schema
version greater than or equal to what the running build requires, specifically so a newer additive
schema keeps an older build servable and a rollback never needs a destructive down-migration. This
PR does not add one.

## Deploy procedure

```
git commit -> GitHub
  -> CI green (.github/workflows/ci.yml: application, rendered-browser-security,
     database-security, api-production-artifact, hetzner-staging-containers)
  -> migrations: supabase db push against the linked staging project (before restart)
  -> dependencies + build: docker compose -f deploy/compose.yaml build
     (reads deploy/env/build.env for the NEXT_PUBLIC_* args)
  -> restart: AVENLYO_RELEASE=<sha> docker compose -f deploy/compose.yaml up -d
  -> health verification:
       docker compose -f deploy/compose.yaml exec api node -e "fetch('http://127.0.0.1:4000/health/ready')..."
       curl https://staging.avenlyo.com/api/health
     (do not consider the deploy complete, or route real traffic to it, until both pass)
  -> rollback (only if verification fails) -- see below
```

## Rollback

Image tags are the deployed commit SHA (`avenlyo-web:<sha>`, `avenlyo-api:<sha>`), never `latest`.
Rollback means:

```
AVENLYO_RELEASE=<previous-known-good-sha> docker compose -f deploy/compose.yaml up -d --no-build
```

-- running the previous image, never rebuilding old source during an incident. `--no-build` is
deliberate: it fails loudly if that tag isn't already present locally rather than silently
rebuilding something different.

Chromium rolls back with it automatically, by construction: the browser binary and its stable
symlink (`/opt/avenlyo/chromium/chrome`, see `deploy/Dockerfile.api`) are baked into the image layer
itself, never a mounted volume, so the previous image's tag is also the previous browser revision.

Caddy configuration changes should be committed and tagged the same way as any other change to this
repository -- `deploy/Caddyfile` is version-controlled, so "which Caddyfile was live" is always a
git question, not a question about what's currently on disk on the host.

## Server security runbook (Hetzner Ubuntu host)

Not executed by this PR. For whoever provisions the actual VM:

- Ubuntu LTS (24.04 at the time of writing).
- A dedicated deployment/application user; do not deploy as root.
- SSH keys only -- `PasswordAuthentication no` in `sshd_config`.
- Disable direct root SSH login once the dedicated user's access is confirmed working.
- Hetzner Cloud Firewall and/or UFW: only 22 (source-restricted to known admin IPs where practical),
  80, and 443 reachable from the internet. Never 3000 or 4000.
- `unattended-upgrades` enabled for OS security patching.
- Keep Docker Engine itself patched the same way -- it is not exempt from the OS's update policy.
- Never mount the Docker socket into any application container. The Docker daemon is never
  reachable over TCP (unix socket, local only).
- `/etc/avenlyo/` -- directory `0750`, files `0640`, owned by a dedicated user/group as described
  above.
- DNS: `staging.avenlyo.com` and `api-staging.avenlyo.com`, both A (and AAAA) records pointing at
  the VM's public IP -- not created by this PR.
- Caddy TLS prerequisite: ports 80 and 443 reachable from the internet before first start, so the
  ACME HTTP-01 challenge can complete.
- **User-namespace / Chromium sandbox verification on the actual Hetzner host is required before
  relying on rendered imports in staging.** This repository's own CI (both the existing
  `rendered-browser-security` job and this PR's new `hetzner-staging-containers` job) needed
  `kernel.apparmor_restrict_unprivileged_userns=0` (or `kernel.unprivileged_userns_clone=1`) set on
  Ubuntu 24.04 GitHub runners for a sandboxed Chromium launch to succeed. Hetzner's Ubuntu 24.04
  image very likely needs the identical host-level sysctl, but this has not been proven against a
  real Hetzner host by this PR -- confirm it there specifically, the same way CI confirms it on the
  runner, before trusting the rendered-import capability in staging.
- Disk/log rotation: see "Logging" below.
- Rollback procedure: see above.

## Resource limits

`deploy/compose.yaml` sets `mem_limit: 2g` for `api` (the dominant driver is an occasional Chromium
render, not steady-state usage) and `mem_limit: 1g` for `web`. These are conservative starting
points, not the product of load testing against a real host -- there is no VM to load test against
yet. They are deliberately not tight enough to make a single render immediately OOM: rendered
concurrency is already bounded by the application's own existing behavior (this PR does not add or
change any parallel-rendering logic).

Estimated VM sizing (unchanged from the earlier read-only audit, restated here for one place to
look): **4 vCPU / 8 GB RAM / ~80 GB disk** recommended for staging; 2 vCPU / 4 GB / 40 GB as a
minimum viable floor. Marked as estimates -- no Hetzner VM has been provisioned to measure against.

## Logging

Fastify's default Pino logger already emits structured JSON (unchanged by this PR). Both containers
write to stdout/stderr; Docker's log driver captures it. Configure bounded rotation at the Docker
daemon level (`log-opts: max-size`, `max-file`) or via `docker compose`'s per-service `logging:`
block when the host is actually provisioned -- not configured by this PR, since it is a host-level
daemon setting rather than something `deploy/compose.yaml` alone controls safely across every Docker
version.

No ELK, Loki, Grafana, Datadog, or other logging SaaS. Never log environment values, tokens,
cookies, raw imported website content, or PII -- this is existing, unchanged application discipline
(the readiness route's sanitized public body, for one example), not new tooling this PR adds.

## Chromium / browser version strategy

`playwright-core@1.62.1` (exact, from `pnpm-lock.yaml`) is what `deploy/Dockerfile.api` installs via
`playwright-core install --with-deps chromium` in the same stage that becomes the runtime image --
never a separately-versioned base image, never a floating tag. The installed revision's real path
(an implementation detail of this exact `playwright-core` version, e.g.
`/opt/ms-playwright/chromium-<rev>/chrome-linux/chrome`) is resolved once, at image build time, via
`playwright-core`'s own `chromium.executablePath()`, and exposed at the stable path
`/opt/avenlyo/chromium/chrome`. `KNOWLEDGE_RENDERER_EXECUTABLE_PATH` is baked into the image as that
stable path, never a hardcoded revision directory. Bumping `playwright-core` in `pnpm-lock.yaml` and
rebuilding the image is the only way this path's target changes.

## What remains manual

Everything this document describes as a procedure, not something this PR executed:

- Provisioning the Hetzner VM.
- The DNS records in "Server security runbook."
- Writing the real `/etc/avenlyo/web.env`, `/etc/avenlyo/api.env`, and `deploy/env/build.env` files
  on whatever host runs this.
- `supabase db push` against the staging project.
- The first `docker compose up`.
- Verifying the Chromium sandbox on the real host, per the note above.
