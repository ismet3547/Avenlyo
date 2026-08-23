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
  `deploy/env/build.env` (real values, never committed -- see `deploy/env/build.env.example`) --
  **only when that file is passed explicitly as `--env-file deploy/env/build.env`.** Its filename
  alone does not make Compose load it; see "Deploy procedure" below for the exact commands.
  They are public values (an anon key scoped by RLS, a base URL) but still never hardcoded into the
  repository, the same way no other deployment-specific configuration is.
- **Runtime, server-only** (everything else): read from `/etc/avenlyo/web.env` and
  `/etc/avenlyo/api.env` on the host via Compose's `env_file:`. Changing one of these does not
  require rebuilding an image, only restarting the container.

**A real failure mode, found by this PR's own CI, not hypothetical:** `apps/web/lib/supabase/config.ts`
validates these at build time and rejects an *empty string*, not only a missing one. If
`deploy/Dockerfile.web`'s build args are left unset, they default to `""`, and `next build` fails
collecting page data for `/auth/callback` with `EnvironmentValidationError` -- it does not silently
produce a build that merely lacks Supabase. Always supply real values via
`--env-file deploy/env/build.env` on the `docker compose build` command itself; there is no safe
"build without them" path for this image.

## Environment files

Never commit a real env file. Templates only:

| Template | Real path on the host | Contents |
|---|---|---|
| `deploy/env/web.env.example` | `/etc/avenlyo/web.env` | Runtime, server-only web config (includes `OPENAI_API_KEY`) |
| `deploy/env/api.env.example` | `/etc/avenlyo/api.env` | Runtime, server-only API config |
| `deploy/env/build.env.example` | `deploy/env/build.env` (on whichever machine runs `docker build`) | `NEXT_PUBLIC_*` build args |

Permissions on the host: `0640`, owned by a dedicated `avenlyo` user/group -- never world-readable,
never readable by any container that doesn't need them.

**`SUPABASE_SERVICE_ROLE_KEY` must never appear in `web.env`.** Confirmed by grep against this
repository: no reference to it exists anywhere in `apps/web`. Web only ever uses the anon key plus
the caller's own session (RLS-scoped); the service-role key is API-only.

`AVENLYO_INTERNAL_BILLING_SECRET` must be byte-identical between `web.env` and `api.env`, or every
billing mutation fails closed by design.

### `OPENAI_API_KEY` goes in **both** env files

`OPENAI_API_KEY` must be present in `/etc/avenlyo/api.env` **and** `/etc/avenlyo/web.env` whenever
the OpenAI text or knowledge features are being exercised. It is not an API-only secret.

This cost a staging run. The first publish failed with

> OpenAI embeddings are not configured. Set OPENAI_API_KEY to publish or test knowledge.

while `api.env` had the key all along. Three knowledge features run inside the **Next.js server
process**, not in the API container:

| Feature | Where it runs | What it needs the key for |
|---|---|---|
| Publishing a reviewed import | `apps/web/lib/knowledge/service.ts` | Embedding every included document |
| "Test your knowledge" search | `apps/web/lib/knowledge/service.ts` | Embedding the query |
| Agent Test | `apps/web/lib/agent/service.ts` | Calling the model |

`apps/web/lib/knowledge/config.ts` treats the key as **optional at boot**, deliberately: the site
starts and every other page works without it. So a missing key does not fail the deploy, fail a
health check, or appear in any log at startup. It surfaces only when an operator clicks publish.
Both `/health/ready` and `/api/health` will report healthy with the key absent.

After adding it to `web.env`, recreate the web container so the new `env_file` contents are read --
`env_file` is applied at container creation, not on restart:

```bash
docker compose -f deploy/compose.yaml up -d --force-recreate web
```

Server-only, in both files. It must never be set as a `NEXT_PUBLIC_*` variable and must never go in
`deploy/env/build.env`: Next.js inlines build args into the browser bundle, which would publish the
key to every visitor. `deploy/env/web.env.example` documents this, and
`apps/web/lib/deployment/env-contract.test.ts` fails CI if the template ever again omits a
server-only variable the web app reads, carries a `NEXT_PUBLIC_*` value, or carries the
service-role key.

`OPENAI_AGENT_MODEL` and `OPENAI_EMBEDDING_MODEL` both default in code and should stay unset. If
you ever set `OPENAI_EMBEDDING_MODEL`, set the identical value in **both** files: the API embeds
live conversation and voice queries against documents the web container embedded, and two different
models produce vectors that do not compare. `OPENAI_PROJECT_ID`, `OPENAI_REALTIME_MODEL`, and
`OPENAI_WEBHOOK_SECRET` belong to the API's voice and webhook paths only -- nothing in `apps/web`
reads them, and this stage of staging does not need them.

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

`AVENLYO_RELEASE` is set from the deployed commit SHA once, exported into the shell before *any*
`docker compose` command, and reused unchanged for both `build` and `up` -- never regenerated
per-command, or the image `build` names and the image `up` asks for silently diverge:

```
export AVENLYO_RELEASE="$(git rev-parse HEAD)"
```

Both `web` and `api` read this same value (`deploy/compose.yaml`'s `environment:` block for each
service), and it also names the image tag (`avenlyo-api:${AVENLYO_RELEASE}`,
`avenlyo-web:${AVENLYO_RELEASE}`), which is what makes rollback a tag switch rather than a rebuild
(see below). The invariant this exists to guarantee: **build once, under this exact tag; deploy that
exact already-built image; never rebuild during rollback.**

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

**A named, real file, not implicit.** `docker compose build` alone does *not* automatically load a
file merely because it is named `deploy/env/build.env` -- Compose interpolates `${VAR}` references
(the `NEXT_PUBLIC_*` build args in `deploy/compose.yaml`) from the shell environment, an explicit
`--env-file`, or Compose's own default `.env` next to the compose file, and none of those is
`deploy/env/build.env` unless it is named explicitly on every command. Leaving this implicit was
this runbook's own bug in an earlier draft: it read correctly but did not work, and this PR already
proved (see "Build-time vs. runtime configuration" above) that an unset `NEXT_PUBLIC_*` value fails
the build outright -- so a command that silently didn't load it would either fail loudly (good) or,
worse, succeed by reusing a stale cached layer from a previous build that did have real args. Every
command below passes `--env-file deploy/env/build.env` explicitly, every time.

```
export AVENLYO_RELEASE="$(git rev-parse HEAD)"

git commit -> GitHub
  -> CI green (.github/workflows/ci.yml: application, rendered-browser-security,
     database-security, api-production-artifact, hetzner-staging-containers)
  -> migrations: supabase db push against the linked staging project (before restart)
  -> BUILD ONCE, under the SHA tag:
       docker compose --env-file deploy/env/build.env -f deploy/compose.yaml build
  -> DEPLOY that exact already-built image -- --no-build must not silently rebuild:
       docker compose --env-file deploy/env/build.env -f deploy/compose.yaml up -d --no-build
  -> health verification:
       docker compose -f deploy/compose.yaml exec api node -e "fetch('http://127.0.0.1:4000/health/ready')..."
       curl https://staging.avenlyo.com/api/health
     (do not consider the deploy complete, or route real traffic to it, until both pass)
  -> rollback (only if verification fails) -- see below
```

`up -d --no-build` deliberately never triggers an implicit build: if the tag `build` just produced
isn't present (a typo in `AVENLYO_RELEASE` between the two commands, for instance), this fails loudly
instead of silently building and deploying something that was never through the "BUILD ONCE" step,
which is exactly the class of drift this two-command split exists to prevent.

## Rollback

Image tags are the deployed commit SHA (`avenlyo-web:<sha>`, `avenlyo-api:<sha>`), never `latest`.
Rollback means pointing `AVENLYO_RELEASE` at a commit whose image was already built by a prior
deploy, and running `up` against it -- never rebuilding:

```
export AVENLYO_RELEASE="<previous-known-good-sha>"
docker compose --env-file deploy/env/build.env -f deploy/compose.yaml up -d --no-build
```

`--env-file` is still required here, for the same reason it's required for `build`: Compose needs it
to resolve the same `${VAR}` references in `deploy/compose.yaml` even though `--no-build` means the
image itself won't actually be rebuilt. `--no-build` is the load-bearing part: it fails loudly if
that tag isn't already present locally rather than silently rebuilding something different -- running
the previous image is the entire point of a rollback, and rebuilding old source during an incident is
exactly the failure mode this command is written to make impossible.

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
  relying on rendered imports in staging.** Two layers were needed, both proven by this PR's own CI,
  not assumed:
  1. **Host kernel**: `kernel.apparmor_restrict_unprivileged_userns=0` (or
     `kernel.unprivileged_userns_clone=1`) -- Ubuntu 24.04 GitHub runners restrict unprivileged user
     namespaces by default, the same restriction the pre-existing `rendered-browser-security` job
     already worked around on a bare runner.
  2. **Container seccomp**: even with the host kernel fixed, the *container's* first attempt failed
     identically ("No usable sandbox!") under Docker's default seccomp profile -- confirmed directly
     in this PR's CI run, not inferred. `deploy/chromium-seccomp.json` (Docker's default profile plus
     Playwright's own documented one-line addition permitting `clone`/`setns`/`unshare`) fixed it.
     `deploy/compose.yaml`'s `api` service already applies it.

  Hetzner's Ubuntu 24.04 image very likely needs the identical host-level sysctl for layer 1, but
  that specific host has not been provisioned or tested by this PR -- confirm it there specifically
  before trusting the rendered-import capability in staging. Layer 2 (the seccomp profile) is baked
  into the image/compose file already and needs no host-specific action.
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

Fastify's default Pino logger already emits structured JSON (unchanged by this PR). All three
containers write to stdout/stderr; `deploy/compose.yaml` sets a bounded `json-file` policy for all
of them via a shared `x-logging` anchor -- `max-size: "10m"`, `max-file: "5"`, roughly a 50 MB
ceiling per service (150 MB across all three). This is a conservative starting point for staging,
not a measured figure -- there is no provisioned host to size it against yet, and it is easy to
raise later if it proves too tight. `docker compose config` renders the resolved `logging:` block
for each service; this PR's CI checks that it's present.

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

## Reproducibility: base images are not currently digest-pinned

`deploy/Dockerfile.api` and `deploy/Dockerfile.web` reference `node:22-bookworm-slim`;
`deploy/compose.yaml`'s `caddy` service references `caddy:2.8-alpine`. Both are tags, not digests --
considered and deliberately left as tags rather than pinned to a `sha256:...` digest for this PR.

**What this means precisely:** an immutable Avenlyo SHA tag (`avenlyo-api:<sha>`,
`avenlyo-web:<sha>`) is exactly reproducible for rollback -- once built, that image's layers do not
change, and re-deploying the same tag later runs the identical bytes. What is *not* currently
guaranteed is that *rebuilding* the same git commit SHA at a later date reproduces byte-identical
output: `node:22-bookworm-slim` and `caddy:2.8-alpine` can each receive upstream patch updates under
the same tag, so a rebuild next month may pick up a newer base image than a rebuild today did, even
from unchanged Avenlyo source. Do not claim full byte-for-byte rebuild reproducibility while these
tags float.

**Why not pin now:** digest-pinning requires recording the exact current digest for each tag, which
this PR cannot verify against a live registry pull in this environment, and turning it into a
dependency-upgrade exercise (choosing and validating exact digests, plus the process for bumping them
later) is explicitly out of this PR's scope. If the team decides the staging reproducibility promise
needs to extend to rebuilds, not just rollbacks, pin `FROM node:22-bookworm-slim@sha256:<digest>` and
`image: caddy:2.8-alpine@sha256:<digest>` as a small, separate, deliberate change -- not bundled into
an unrelated correction.

## What remains manual

Everything this document describes as a procedure, not something this PR executed:

- Provisioning the Hetzner VM.
- The DNS records in "Server security runbook."
- Writing the real `/etc/avenlyo/web.env`, `/etc/avenlyo/api.env`, and `deploy/env/build.env` files
  on whatever host runs this.
- `supabase db push` against the staging project.
- The first `docker compose up`.
- Verifying the Chromium sandbox on the real host, per the note above.
