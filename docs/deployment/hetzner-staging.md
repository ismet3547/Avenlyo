# Avenlyo Hetzner staging

Runbook for the production-like staging deployment.

**Status.** The Hetzner staging runtime exists and is running: the VM is provisioned, DNS resolves,
Caddy holds certificates for both hostnames, and Phase 18 was verified end to end on it — health,
sandboxed Chromium, hosted migrations and the Agent Test path.

**Phase 19 is deployed.** It was merged, its migration was applied to the hosted staging project, and
real staging verification passed on the host. The hosted staging schema is at **19**, the Phase 19
rollback drill was performed and passed, and the runtime now running on the host is Phase-19
tree-equivalent.

**Phase 20 is not deployed.** Its code is on `feat/phase-20-production-readiness` and green in CI;
nothing from Phase 20 has been applied to the staging host, and Phase 20 adds no migration — the
schema contract stays at 19. Production does not exist at all; see `docs/deployment/production.md`.
Everything below is the procedure a human runs.

```
                                Internet
                                    |
                            [ 80 / 443 published ]
                                    |
                        +-----------------------+
                        |         caddy         |   auto TLS, host-based routing
                        |  (on BOTH networks)   |
                        +-----------------------+
                         /          |           \
        staging.avenlyo.com         |            api-staging.avenlyo.com
                |                   |                        |
   == web_edge network ==           |         == api_edge network ==
                |                   |                        |
             web:3000               |                     api:4000
          (next start)              |         (fastify + in-process messaging,
                |                   |          billing and knowledge-import
                |                   |          workers + sandboxed Chromium)
                |                   |                        |
                |              :8080 (NOT published)         |
                +---------------->--+------------------------+
                  web's server-side calls: web -> caddy:8080 -> api
                                                             |
                                                    hosted Supabase
                                            (external, authoritative -- staging)
```

**Two networks, not one.** `web` sits on `web_edge`, `api` on `api_edge`, and only Caddy is on both.
`web` and `api` share no network, so nothing but Caddy can open a socket to the API — which is what
makes the API's trusted-proxy boundary structurally one hop rather than "any private container".

**Public path:** Internet → Caddy `80/443` → `web:3000` or `api:4000`.
**Internal server-side path:** `web` → `caddy:8080` → `api:4000`, for the dashboard's appointment,
billing and integration server actions (`AVENLYO_API_URL=http://caddy:8080`).

`3000`, `4000` and Caddy's `:8080` are **not** published to the host — `:8080` appears in the
Caddyfile but never in the compose `ports:` block, so it is reachable only from the two compose
networks, never from the host or the internet. Caddy's `80`, `443` and `443/udp` are the only
published ports in the deployment.

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
| `deploy/env/staging.public.env.example` | assembled into `deploy/env/build.env` | The non-secret staging deployment profile: identity, release, hostnames, public URLs, internal boundary |
| `deploy/env/production.public.env.example` | assembled into `deploy/env/build.env` | The same contract, production values. Production is not deployed |
| `deploy/env/build.env.example` | `deploy/env/build.env` (on whichever machine runs `docker build`) | The two `NEXT_PUBLIC_SUPABASE_*` build args that cannot be committed |

`deploy/env/build.env` is the **one** `--env-file` every command in a deploy reads -- build,
validation, preflight and `up`. Assemble it as `build.env.example` documents:

```bash
cat deploy/env/staging.public.env.example deploy/env/build.env.example > deploy/env/build.env
# then fill in the two NEXT_PUBLIC_SUPABASE_* values and AVENLYO_RELEASE
```

Never print it. To confirm a key is present, count the key and never echo the value:

```bash
grep -c '^AVENLYO_DEPLOYMENT_ENV=' deploy/env/build.env
```

## Known host facts that affect the procedure

Two properties of this host are load-bearing for every deploy, and neither is obvious from the
repository:

**There is no Node runtime.** The host builds everything inside Docker. So
`.github/scripts/assert-deployment-profile.mjs` is **not** a host step -- it is a CI and local source
gate, discharged by a green CI run on the exact release SHA. The host-side validation is the Compose
one, which needs only what the host already has:

```bash
docker compose --env-file deploy/env/build.env -f deploy/compose.yaml config --quiet
```

It must exit 0 and print nothing. Never drop `--quiet`: plain `config` renders `env_file:` contents,
which on this host means every secret in `/etc/avenlyo/api.env`.

**`remote.origin.fetch` is narrowed** to `+refs/heads/infra/hetzner-staging:refs/remotes/origin/infra/hetzner-staging`.
`origin/main` therefore does not exist locally and is never updated, so `git pull` cannot bring in a
release from `main`. Fetch it explicitly:

```bash
git fetch origin main
git checkout --detach <exact-40-char-sha>
git rev-parse HEAD
```

This is recorded as operational debt rather than fixed in passing: widening the refspec is a
persistent change to a live host's git configuration, and it belongs in a deliberate maintenance
step, not in a deployment.

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

Because staging runs `NODE_ENV=production`, staging also has to declare which deployment it is:

```
AVENLYO_DEPLOYMENT_ENV=staging
```

A production-mode container without it refuses to start. `NODE_ENV` cannot answer the question —
production will run `NODE_ENV=production` too.

Payments are intentionally not configured at this project stage. The Stripe rule keys off the
deployment identity, not off `NODE_ENV`:

```ts
if (deploymentEnvironment === 'production' && env.STRIPE_MODE === 'test') {
  throw new Error('STRIPE_MODE must be live in a production deployment.');
}
```

So `STRIPE_MODE=test` is permitted on staging, which is the correct mode for staging. It was
previously keyed on `NODE_ENV`, which rejected a test key on staging — harmless only because staging
leaves Stripe unset, and wrong the moment staging configured it.

The key/mode prefix rule is independent of environment and still applies everywhere:
`STRIPE_MODE=test` requires an `sk_test_…` secret, `STRIPE_MODE=live` requires `sk_live_…`.

Leaving `STRIPE_MODE` and every `STRIPE_*` variable **entirely unset** in `api.env` remains the
current staging posture: the application's own capability system (`isStripeBillingConfigured` in
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

**Never automated.** No container startup runs a migration, and none should. Phase 18's and Phase
19's migrations were pushed to the linked staging project by hand, in this order. Phase 20 adds no
migration. The order a human follows:

1. CI green on the PR that needs the new schema.
2. Take whatever backup/checkpoint the team's standard practice calls for.
3. `supabase link --project-ref <staging-project-ref>` (once), then `supabase db push` against the
   linked **staging** project -- never hosted production, never run from this PR.
4. Verify the new schema version is live (the same `platform_readiness_probe` RPC
   `apps/api/src/routes/health.ts` already calls).
5. Deploy the new containers (see "Deploy procedure" below).
6. Verify API `GET /health/ready` reports `ready`.
7. Verify web `GET /api/health` reports `ok`.

Phase 19 added one migration, `20260901000000_phase_19_web_chat_poll_bounds.sql`, and requires
**schema version 19** (`REQUIRED_SCHEMA_VERSION` in `apps/api/src/observability/readiness.ts`). It is
additive; no destructive down-migration exists or is needed. It has been applied to hosted staging,
and the hosted staging schema is at 19. **Phase 20 adds no migration and does not move the
contract.**

The readiness contract is what makes this safe to sequence this way. `evaluateReadiness` accepts a
schema version greater than or equal to what the running build requires, so a newer schema keeps an
older build servable. Schema 19 honours that in both directions: it advances the contract **and**
preserves the Phase 18 two-argument `get_web_chat_messages` overload, so a rolled-back Phase 18 image
still makes its exact old call successfully. See "Schema contract 19 and rollback compatibility".

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

### Rolling back across the Phase 19 boundary

A routine rollback switches **only the SHA-tagged images**. Keep the Phase 19 runtime exactly as it
is: the `web_edge` / `api_edge` split, Caddy's internal `:8080` listener, and
`AVENLYO_API_URL=http://caddy:8080` — which, from Phase 20 onward, is declared in the deployment
profile rather than in `/etc/avenlyo/web.env`.

Do **not** check out the Phase 18 `deploy/compose.yaml` or `deploy/Caddyfile` while leaving the
Phase 19 environment in place. Those two are a matched pair: the old compose file puts every service
back on one network and defines no `:8080` listener, so a host still pointing `AVENLYO_API_URL` at
`http://caddy:8080` would have nothing answering, and the dashboard's appointment, billing and
integration actions would fail. If you genuinely need the old topology, revert the env file with it.

**Schema 19 stays deployed.** Do not attempt to undo the migration. A rolled-back Phase 18 image
calls `get_web_chat_messages(target_token_hash, target_after)`, and schema 19 keeps exactly that
overload — bounded, service-role only, delegating to the current implementation — precisely so this
rollback works without a down-migration. Readiness accepts a schema newer than the build requires,
so an 18 image reports ready against 19 and its web-chat polling works.

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

Provisioning, DNS, the real env files on the host, the first `docker compose up`, and the Chromium
sandbox check on the real host were all done during the Phase 18 deployment; the runtime described
above is live. What stays manual on every release, by design:

- `supabase db push` against the linked **staging** project, before the containers restart.
- The `build` / `up -d --no-build` pair, with `AVENLYO_RELEASE` exported once.
- Health verification afterwards: API `/health/ready`, web `/api/health`.

**Phase 19 is complete on staging**: its migration was pushed to hosted staging, its images were
built and deployed, the `AVENLYO_API_URL` cutover to `http://caddy:8080` was made, and the rollback
drill passed.

Outstanding for **Phase 20** specifically, none of which has been done:

- Phase 20 has not been deployed to the staging host. No image has been built or deployed from it,
  and no file under `/etc/avenlyo/` has been touched.
- On the next deploy, `deploy/env/build.env` must be reassembled from
  `deploy/env/staging.public.env.example` plus the two `NEXT_PUBLIC_SUPABASE_*` values, because the
  profile now carries `AVENLYO_DEPLOYMENT_ENV` and `AVENLYO_API_URL`, and `docker compose config`
  fails closed without them.
- `/etc/avenlyo/api.env` must gain `AVENLYO_DEPLOYMENT_ENV=staging`, or the container refuses to
  start under `NODE_ENV=production`. It must equal the profile's value.
- Any `AVENLYO_API_URL` line left in `/etc/avenlyo/web.env` should be deleted: Compose's
  `environment:` now supplies it from the profile, so the stale line is inert rather than dangerous,
  but leaving it preserves the two-authority ambiguity Phase 20 removed.

Both env-file edits are one-time, non-secret, and key-level. The exact secret-safe procedure --
how to test for the key without printing its value, and how to edit with a backup while preserving
owner/group/mode -- is in `docs/production-runbook.md`, "Migrating a host off the pre-Phase-20 env
layout". Confirm afterwards with counts, never with `cat`:

```bash
sudo grep -c '^AVENLYO_DEPLOYMENT_ENV=' /etc/avenlyo/api.env   # must be 1
sudo grep -c '^AVENLYO_API_URL='        /etc/avenlyo/web.env   # must be 0
```

### Phase 21A attempt, 2026-08-28

A first promotion attempt reached the pre-build gate and stopped there. It found a real defect in the
merged Phase 20 release: the deployment assertion asked `docker compose config` where a value came
from, but Compose resolves `env_file:` into the rendered environment, so a host whose `api.env`
correctly declared `AVENLYO_DEPLOYMENT_ENV=staging` failed the gate. CI had not caught it because its
fixture wrote an empty `api.env`.

Nothing was deployed. The host was returned to its exact pre-attempt state, verified by checksum, and
the running containers were never recreated. The three findings above -- no Node runtime, narrowed
refspec, and the two env-file migrations -- were all first observed during that attempt.

## API edge security (Phase 19)

Everything below concerns the Fastify API only. The Next.js application is a separate surface with
its own headers and its own threat model, and none of this is imposed on it.

### Trusted proxy, and why public forwarding headers are not believed

Caddy is the only internet-facing process, and `deploy/compose.yaml` gives `api` an `expose:` entry
rather than a `ports:` mapping, so nothing outside the compose network can open a socket to it.

The compose file also runs **two** bridge networks rather than one. `web_edge` carries `web` and
Caddy; `api_edge` carries `api` and Caddy. `web` and `api` never share a network, so the set of
containers that can open a socket to the API is exactly one: Caddy. That is what makes a forwarding
header meaningful. A single shared network -- which is what this ran on before -- made the boundary
"any private container", because the web container was also an internal peer of `api:4000`.

Neither network is `internal: true`: both containers need outbound access for Supabase, OpenAI,
Stripe, Twilio and Chromium.

Because `web` can no longer address `api` directly, its server-side dashboard actions (appointments,
billing, integrations) go through an **unpublished** Caddy listener on `:8080`, reachable from the
compose networks alone and never from the host or the internet. `AVENLYO_API_URL` is therefore
`http://caddy:8080`, not `http://api:4000`. **A host still carrying the old value must be updated at
the next deploy or those three action groups stop resolving.**

Fastify is configured with a `trustProxy` **predicate**, not `true` and not a hop count. It honours
`X-Forwarded-For` only when the peer that presented it holds a private or loopback address -- which
here means Caddy. A request arriving from a public address is treated as its own client no matter
what headers it carries, so an internet caller can never nominate its own abuse-control identity, or
somebody else's. `trustProxy: true` would have handed exactly that ability to anyone.

A hop count was rejected for the same reason: it says "believe the Nth entry" without asking who
wrote it, and keeps believing if the topology gains a hop or the API is ever exposed by mistake.

`deploy/Caddyfile` independently replaces `X-Forwarded-For` and `X-Real-IP` with `{remote_host}`
rather than appending to whatever arrived, so an injected chain does not survive the hop. Two
controls, either sufficient on its own.

**The defect this fixed.** Before Phase 19 `request.ip` was the socket peer, which behind Caddy is
Caddy. Every visitor therefore collapsed to one identity, and the Phase 7 per-client web-chat quotas
behaved as a single global quota shared across every tenant -- one abuser could exhaust it and lock
out every widget. Addresses are now canonicalised before use (IPv4 whole, IPv6 to its `/64`, so one
subscriber cannot rotate through a subnet to mint identities) and hashed, so no limiter store or log
line holds an address.

### Rate limiting: which layer answers which question

| Route class | Edge (per process) | Durable (database) |
|---|---|---|
| Health / readiness | **exempt** | n/a |
| Web-chat session create | 20/min | 10/min, authoritative |
| Web-chat message | 60/min | 30/min, authoritative |
| Web-chat poll | 120/min | 240/min, authoritative |
| Authenticated / general API | 600/min (the global default) | n/a |
| Provider webhooks | **exempt** | n/a |

There is deliberately no separate `authenticated` policy. One earlier existed at 600/minute and was
wired to nothing, so the documented ceiling was 600 while the enforced one was a 300 global default.
Authenticated routes now inherit the generous global ceiling, which a newly added route cannot
forget to opt into; only Web Chat carries explicit stricter overrides.

The edge layer is a shield: it makes a flood cheap to refuse before it becomes database, AI or
provider work. It is **per replica and in memory** -- run two API containers and a client gets two
allowances. That is an accepted limitation, not an oversight. Anything that must be exactly enforced
lives in the database, where `consume_messaging_rate_limit` counts correctly across every replica.

Health is exempt because Docker treats a non-200 healthcheck as a dead container: letting public
traffic consume a shared health allowance would let an outsider convince the orchestrator to restart
a healthy process.

Provider webhooks are exempt because Twilio, Stripe and OpenAI legitimately burst from a small pool
of addresses, and a retry wave after an outage is precisely the shape a per-IP quota rejects.
Dropping those is data loss with retry amplification behind it. Those routes are gated by something
better than an IP guess -- a mandatory signature check, unchanged by this phase -- plus a body limit
bounding what an unsigned request can cost.

**HTTP 429 operationally** means the edge or the durable quota refused the request; it is not an
error condition to page on. Each refusal writes one `warn` line carrying the policy name, normalised
route, method, status, request id and a truncated hash of the limiter key -- never an address.

### Request size policy

Fastify's undocumented 1 MiB default is replaced with explicit ceilings: 256 KiB globally, 64 KiB
for Twilio form callbacks, 16 KiB for a web-chat message (the contract is 2,000 characters), 4 KiB
for a session request. Stripe (128 KiB) and OpenAI (64 KiB) keep the limits they already had --
those were sized against real provider payloads and lowering them risks rejecting valid events.
Oversized bodies are refused by the parser, before any handler, RPC or provider call runs, and no
raw body is logged on failure.

### Security headers

`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, a
`Permissions-Policy` denying camera/microphone/geolocation/payment, and a CSP that is a genuine API
policy (`default-src 'none'`, `frame-ancestors 'none'`) rather than Helmet's document defaults --
those permit scripts and inline styles, which would be both untrue and looser here. HSTS is emitted
in production only, where the API is actually behind Caddy's TLS.

Deliberately **not** enabled: `Cross-Origin-Resource-Policy` and `Cross-Origin-Embedder-Policy`.
Helmet's default CORP is `same-origin`, which instructs browsers to block cross-origin reads of API
responses -- exactly what the embedded chat widget does on every session, message and poll. Enabling
them to be able to say "Helmet is on" would break Web Chat on every customer site. CORS remains the
access control for this surface.

### Poll coalescing and session expiry

`get_web_chat_messages` previously ran an unconditional `UPDATE` on `web_chat_sessions` per call. The
touch is now coalesced to at most once a minute, which is a real if bounded change to expiry timing
and is worth stating exactly rather than calling the lifetime unchanged.

Expiry is 24 hours after the last **persisted** activity, not the last request. A poll landing inside
the one-minute coalescing window leaves `expires_at` where the previous write put it, so the
effective TTL can sit up to 60 seconds behind an exact "last poll + 24h" model — and never ahead of
it. What it cannot do is expire a session someone is still using: the drift is bounded by a window
roughly three orders of magnitude smaller than the lifetime, so a client that is still polling
refreshes the row long before expiry approaches. An idle session expires on exactly the schedule it
always did, because the last write is the last activity either way.

Both bounds are asserted in `supabase/tests/database/web_chat_poll_bounds.test.sql`.

### Schema contract 19 and rollback compatibility

Phase 19 advances `platform_schema_contract.schema_version` to **19**, and
`REQUIRED_SCHEMA_VERSION` in `apps/api/src/observability/readiness.ts` moves with it.

That is not bookkeeping. This build's web-chat poll calls
`get_web_chat_messages(target_token_hash, target_rate_scope, target_after)`, which does not exist on
an 18 database. Left at 18, a Phase 19 process would have reported **ready** against a schema where
every poll fails — the exact outcome the contract exists to prevent.

The readiness comparison stays `>=`, so a schema newer than the running build remains compatible and
a rollback still needs no destructive down-migration. That promise only holds if the newer schema
keeps answering the older build's calls, so the Phase 19 migration **recreates** the Phase 18
two-argument signature — same parameter names, because PostgREST calls RPCs by name — as a thin
delegate to the current implementation.

The delegate is not a restoration of the old behaviour. It contains exactly one narrow indexed
existence lookup — does a live session hold this token hash — and nothing else of its own: no
messages query, no session touch or update, and no result limit. The poll quota, the session lookup
that drives the coalesced touch, and the 100-row ceiling all remain in the three-argument
implementation it delegates to.

That lookup runs *before* the scope is derived, deliberately. The authoritative path charges the
quota before its own session lookup, which is right there because its scope comes from the canonical
client address and cannot be inflated by rotating tokens. Here the scope comes from a
caller-supplied token, so an unknown one is refused before it reaches the limiter at all. That is
not fixing a durable-storage leak — an unknown token that did reach the limiter would have its
`INSERT ... ON CONFLICT` rolled back by the same transaction's `42501`, and no committed row would
survive. It avoids the aborted write, its WAL and its dead tuple, makes the safe ordering explicit
where the input is untrusted, and stops the property depending on every future caller propagating
the error rather than swallowing it.

The one thing a rolled-back binary cannot supply is a client rate scope, since it predates the
trusted-proxy work, so the scope is derived deterministically from the session token hash: a
per-session bucket rather than a per-client one. Coarser on purpose — it still bounds any single
session's polling, and a rolled-back release is a temporary state.

Both overloads are `service_role` only, both are `security definer` with an empty `search_path`, and
`supabase/tests/database/web_chat_poll_bounds.test.sql` asserts that exactly those two exist,
that both named-argument call shapes resolve to the intended overload, and that the compatibility
path consumes the durable quota rather than bypassing it.

### Intentionally deferred

- **Redis-backed limiting.** Would make the edge layer global rather than per replica. Deferred, not
  forgotten: it is a new stateful runtime dependency, staging runs one API container today, and the
  durable layer already provides the correctness the edge only approximates.
- **WAF / CDN.** Not a Phase 19 dependency. Volumetric absorption in front of Caddy is a separate
  decision with its own operational surface.
- **The web-chat `OPTIONS` handler is unreachable.** `@fastify/cors` answers the preflight first, so
  the route's own iframe-origin check never runs. Not a vulnerability -- the plugin replies with the
  configured origin rather than the caller's, so a foreign origin's request is still refused by the
  browser, and the real `GET`/`POST` handlers enforce the iframe origin server-side regardless.
  Recorded here because it is dead code that reads as if it were load-bearing.
