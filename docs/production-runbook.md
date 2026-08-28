# Avenlyo production runbook

Operational reference for running Avenlyo in production. It covers how to deploy, how to tell
whether a deployment is healthy, and what to do — and deliberately not do — when a queue backs up or
a provider result is ambiguous.

Everything here is observation. Avenlyo never automatically resends an ambiguous SMS, retries an
ambiguous booking, reopens a suppressed follow-up, deletes a failed webhook event, resolves a
handoff, or changes billing state. The Phase 7–13 state machines remain the only authority over
product state, and reading operational status never mutates anything.

## Deployment environment

Staging and production both run `NODE_ENV=production`, deliberately, so staging exercises the same
runtime behaviour that production will. That means `NODE_ENV` cannot tell them apart, and anything
keyed off it would treat the two as one environment.

`AVENLYO_DEPLOYMENT_ENV` is the value that distinguishes them. It is `development`, `staging`, or
`production`, and it is what every environment-sensitive check reads.

A process running `NODE_ENV=production` that does not declare it **refuses to start**. Guessing is
the failure this prevents: the wrong guess points production at a staging database, or waves a `test`
Stripe key through as if it were live. Failing to boot is loud and recoverable; guessing is neither.

## Deployment order

The model is **build once, deploy that image**. Images are tagged with the exact 40-character commit
SHA — never `latest`, never a branch, never an abbreviation — so a tag names one set of bytes
forever, and the thing verified in staging is the same bytes that reach production.

Every command below reads **the same `--env-file`**: `deploy/env/build.env`, assembled from the
source-controlled public profile for the environment plus the two browser-facing Supabase values
(see `deploy/env/build.env.example`). One file, so the profile that is validated is the profile that
is built, preflighted and deployed.

1. **Back up.** Confirm the managed Supabase backup/PITR capability for this project and plan is
   enabled and current. Avenlyo does not ship a home-grown dump scheduler, because that would need
   long-lived service credentials on a host we do not control. Do not claim backups exist unless the
   provider console shows they do.

2. **Check out the exact release SHA** and put it in the profile as `AVENLYO_RELEASE`.

   A deployment host's clone may have a narrowed `remote.origin.fetch` refspec, in which case
   `origin/main` is never updated and `git pull` silently deploys nothing new. Fetch the release
   explicitly rather than relying on a tracking branch:

   ```bash
   git fetch origin main
   git checkout --detach <exact-40-char-sha>
   git rev-parse HEAD          # must print the SHA you intended
   ```

   Untracked files, including `deploy/env/build.env`, survive a checkout. Confirm the **tracked**
   tree is clean with `git status --porcelain --untracked-files=no`.

3. **Validate the deployment profile on the host.** Offline; contacts nothing; needs only Docker.

   ```bash
   docker compose --env-file deploy/env/build.env -f deploy/compose.yaml config --quiet
   ```

   It must exit 0 and print **nothing**. `--quiet` is not cosmetic — see
   [Never render the full compose config](#never-render-the-full-compose-config).

   This catches a profile missing any required substitution (`AVENLYO_DEPLOYMENT_ENV`,
   `AVENLYO_API_URL`), a malformed compose file, and an unresolvable path.

   The deeper source and topology contract — network separation, published ports, Caddy's literal
   upstreams, image tagging, provenance of the deployment identity — is asserted by
   `.github/scripts/assert-deployment-profile.mjs`, which runs in **CI and locally, not on the
   deployment host**. It is a source gate: it reasons about `deploy/compose.yaml` itself, needs a
   Node runtime the host deliberately does not have, and answers questions about the release rather
   than about this host. A green CI run on the exact SHA is what discharges it.

4. **Build the images once**, tagged with that SHA. Building is not deploying and mutates no
   provider:

   ```bash
   docker compose --env-file deploy/env/build.env -f deploy/compose.yaml build web api
   ```

5. **Prove the exact images exist** before anything runs them:

   ```bash
   docker image inspect "avenlyo-api:${AVENLYO_RELEASE}" > /dev/null
   docker image inspect "avenlyo-web:${AVENLYO_RELEASE}" > /dev/null
   ```

6. **Preflight, as a one-off container from that exact image.** See
   [ops:preflight](#opspreflight) for what it checks and why it is run this way and not as a host
   command. Read-only; starts no dependency; deploys nothing.

   ```bash
   docker compose --env-file deploy/env/build.env -f deploy/compose.yaml \
     run --rm --no-deps -T api node dist/scripts/ops-preflight.js
   ```

   It must exit 0 — with one permitted exception on a release that carries a migration, where
   `schema_compatible` will fail until step 7 has run. Nothing else may fail. If any other check
   fails, stop: the deployment is misconfigured and no migration should be applied.

7. **Apply migrations, before the new application code.** Migrations are additive only; there are no
   destructive down migrations. Additive-first is what makes the order safe in both directions: the
   currently running older code keeps working against the newer schema, so the migration is not a
   commitment to the deploy that follows it.

8. **Re-run the same preflight command.** Now it must exit 0 with **no** exception. This is the gate:
   the schema is in place, the profile is proven, and nothing has been deployed yet.

9. **Deploy API and workers** with `up -d --no-build`. `--no-build` is not an optimisation: without
   it Compose may rebuild from the host's working tree, which silently deploys bytes nobody verified.

   ```bash
   docker compose --env-file deploy/env/build.env -f deploy/compose.yaml \
     up -d --no-build --wait web api caddy
   ```

10. **Run non-destructive smoke checks**, as a one-off container from the exact release image.
    Reads only public endpoints; needs no credential.

    ```bash
    docker compose --env-file deploy/env/build.env -f deploy/compose.yaml \
      run --rm --no-deps -T api node dist/scripts/smoke-production.js
    ```

    It must exit 0, and `api_release` must be among the checks it reports.

    `run`, not `exec`, and that is load-bearing. The one-off container is created from
    `avenlyo-api:${AVENLYO_RELEASE}` — the image the profile *intended* — while the probes hit
    whatever is actually serving the public hostnames. If `up` silently kept the previous image, the
    deployment reports the old SHA, this container expects the new one, and `api_release` fails.
    Under `exec` the expectation and the reported value would come from the same process and the
    check could never fail, which is the failure nobody notices because everything is green.

    Targets and expected release come from the deployment profile Compose already passes in, so the
    command is identical for staging and production. To point it somewhere else, set
    `AVENLYO_API_BASE_URL`, `AVENLYO_WEB_BASE_URL` or `AVENLYO_EXPECTED_RELEASE` explicitly —
    all three are non-secret and override the profile.

11. **Confirm operational state**, inside the running API container.

    ```bash
    docker compose --env-file deploy/env/build.env -f deploy/compose.yaml \
      exec -T api node dist/scripts/ops-status.js
    ```

    It must exit 0, no capability may be `partial`, and expected worker components should be
    reporting recent successes.

    `exec`, not `run`, and that is load-bearing too — for the opposite reason. This command describes
    the deployment that is actually running, so it has to execute inside it. A one-off container
    would describe a process nobody is using.

> **The whole sequence above needs only `git`, Docker and Docker Compose on the host.** No `node`,
> no `pnpm`, no source checkout beyond the release itself. That is deliberate: the Hetzner staging
> host has no Node runtime, and a documented step an operator cannot run is not a procedure. Any
> `pnpm …` command elsewhere in this document is a **local development** convenience, never a host
> requirement.

## Rollback

**Application rollback:** redeploy the previous image by its exact SHA tag, again with `--no-build`.
This works because readiness requires `database schema >= required`, never equality, so an older
build keeps serving against a newer additive schema.

**There is no schema rollback, and none is needed.** Migrations are additive, so the newer schema
stays in place and the older application ignores what it does not know about. Do not write a down
migration to "undo" a deploy — that turns a working rollback into data loss.

If a rollback target's SHA is not known, that is the problem to fix first: it is recorded in the
image tag, in `AVENLYO_RELEASE`, and in every health response and log line of the deployment being
replaced.

## Topology and the trust boundary

Two ingress networks, not one shared network:

```
internet ──▶ caddy ──▶ web:3000        (web_edge)
                   └─▶ api:4000        (api_edge)

web ──▶ caddy:8080 ──▶ api:4000        (web's only path to the API)
```

Web and api share no network, so `http://api:4000` does not resolve from the web container and
cannot come back by accident. The web container's server-side API path is `http://caddy:8080`, an
internal listener that is never published to the host.

This is structural, not stylistic. The API trusts forwarded client-IP headers only from a peer on a
private or loopback address, and only one hop — so if a second container could reach the API
directly, an attacker who reached that container could forge the client IP the rate limiter keys on.
One network path in means one hop, and one hop means the header can be trusted.

Consequences to preserve when changing anything here:

- Caddy's upstreams (`web:3000`, `api:4000`, `:8080`) are literals in `deploy/Caddyfile` and are not
  configurable. Environment variables choose the **public hostnames** only. A variable that could
  choose a destination would be a variable that could redirect traffic.
- Caddy replaces inbound forwarding headers on all three routes rather than appending to them, so a
  client cannot inject its own hop.
- Only Caddy publishes ports, and only `80`, `443`, and `443/udp`. `3000`, `4000`, and `8080` are
  never published.
- `trustProxy` is a predicate over the peer address. It is never `true` and never a hop count; both
  would trust whatever the last hop claimed.

`.github/scripts/assert-deployment-profile.mjs` asserts all of this for both targets in CI, and CI
proves each guard by injecting the defect.

It distinguishes two kinds of question, because conflating them cost a release:

- **Final rendered values** — published ports, network attachment, image tags, container hardening —
  are read from `docker compose config`.
- **Provenance** — "does `deploy/compose.yaml` declare this key, or does it come from the host's env
  file?" — is read from the **compose source**. It cannot be read from the render, because Compose
  resolves `env_file:` into the rendered `environment:` map, so a correctly configured host's
  `/etc/avenlyo/api.env` appears there indistinguishably from a compose-declared value.

CI's fixture writes a realistic non-empty `/etc/avenlyo/api.env` so that merge actually happens, and
a dedicated step fails if it stops happening — otherwise the provenance guards would be tested
against a shape no real host has.

## Rate limiting

Abuse controls are per-scope and enforced in the database, so they hold across replicas rather than
per process. Unauthenticated requests are keyed on the trusted client IP described above;
authenticated requests are keyed on the identity, so one tenant cannot exhaust another's budget.

A `429` is a correctly enforced limit, not an incident. Rate-limit rejections do not make a replica
unready and do not indicate a failure of the API.

Polling endpoints coalesce concurrent identical polls rather than admitting each one, so a client
that opens many tabs produces one unit of work instead of many. Read a burst of coalesced polls as
the mechanism working.

## Health endpoints

| Endpoint                | Meaning                                                  | Dependencies  |
| ----------------------- | -------------------------------------------------------- | ------------- |
| `GET /health`           | Liveness (compatibility alias for the original endpoint) | none          |
| `GET /health/live`      | The process is serving HTTP                              | none          |
| `GET /health/ready`     | This replica can safely take production traffic          | database only |
| `GET /api/health` (web) | The Next.js server is serving                            | none          |

Liveness never touches Supabase or any provider, so a provider outage cannot restart healthy pods.

Readiness returns `200` when it is safe to route traffic and `503` when it is not. It validates local
facts only: core configuration present, no half-configured provider, database reachable, schema
compatible, no configured worker scheduler failed to start, and the process is not draining. It
deliberately never pings OpenAI, Twilio, Google, ezyVet, or Stripe — a provider outage must not turn
every replica into a client hammering that provider on every load-balancer check. Provider execution
truth lives in the durable queues instead, and is read through `ops:status`.

The public readiness body is intentionally uninformative:

```json
{ "service": "avenlyo-api", "status": "not_ready", "release": "...", "request_id": "..." }
```

The reason is written to the sanitized server log and visible through `ops:status`. It is never in
the public body, because that endpoint is reachable by anyone who can reach the load balancer.

## Release identification

Set `AVENLYO_RELEASE` on both API and web. In a deployed environment it must be the **exact
40-character lowercase commit SHA** — not `latest`, not a branch name, not an abbreviation.
`ops:preflight` rejects anything else, because the build-once model depends on a tag naming one set
of bytes, and an abbreviation or a moving tag breaks that. Locally it may be anything, and reports
`unknown` when unset.

It appears in health responses, every structured log line, runtime heartbeats, and `ops:status`, and
it is never generated per request.

## ops:preflight

```bash
docker image inspect "avenlyo-api:${AVENLYO_RELEASE}" > /dev/null
docker compose --env-file deploy/env/build.env -f deploy/compose.yaml \
  run --rm --no-deps -T api node dist/scripts/ops-preflight.js
```

Answers a different question from `ops:status` and from the smoke checks: **is this configuration
safe to deploy**, asked before anything is applied. `ops:status` describes a running deployment, and
`smoke:production` verifies one after the fact. Neither substitutes for the others.

It is read-only. It writes nothing, contacts no provider, and sends no message. The only database
call it makes is the same `platform_readiness_probe` readiness already uses, which returns a schema
version and nothing else.

### Never render the full compose config

```bash
# SAFE -- validates and prints nothing
docker compose --env-file deploy/env/build.env -f deploy/compose.yaml config --quiet

# UNSAFE on a real host -- prints every secret
docker compose --env-file deploy/env/build.env -f deploy/compose.yaml config
```

Compose resolves `env_file:` into the rendered service `environment:` map. On a real host that means
plain `docker compose config` prints the contents of `/etc/avenlyo/api.env` — the Supabase
service-role key, the internal billing secret, the OpenAI key, every provider credential — as
ordinary YAML.

So, without exception:

- **Never** run plain `config` where its output is captured: no pipe into a log, no paste into a
  ticket or chat, no CI step that echoes it, no `tee`.
- Use `--quiet` for validation. It is the documented operator form precisely because it answers
  "is this valid?" without answering "what is in it?".
- If you must inspect the render while debugging, redirect it to a file with restrictive permissions,
  read the specific keys you need, and delete it.
- **Never** `cat` `/etc/avenlyo/api.env`, `/etc/avenlyo/web.env`, or `deploy/env/build.env`. To check
  whether a setting is present, test for the **key** and never print the value:

  ```bash
  sudo grep -c '^AVENLYO_API_URL=' /etc/avenlyo/web.env   # prints a count, never a value
  ```

`.github/scripts/assert-deployment-profile.mjs` captures the render internally and never prints it —
its findings are fixed, source-controlled strings naming a setting or a service. That is deliberate,
and any new check added to it must keep that property.

### Migrating a host off the pre-Phase-20 env layout

Phase 20 moved `AVENLYO_API_URL` out of `/etc/avenlyo/web.env` and into the deployment profile, and
made `/etc/avenlyo/api.env` responsible for declaring `AVENLYO_DEPLOYMENT_ENV`. A host provisioned
before that needs two one-time, non-secret edits. Both are key-level operations; neither prints a
value.

```bash
# 1. The API must declare its deployment identity, or it refuses to start under NODE_ENV=production.
sudo grep -c '^AVENLYO_DEPLOYMENT_ENV=' /etc/avenlyo/api.env      # 0 means it must be added

# 2. The obsolete second authority for the internal boundary.
sudo grep -c '^AVENLYO_API_URL=' /etc/avenlyo/web.env             # 1 means it must be removed
```

Back up before editing, preserve the target's owner/group/mode, and change only the named
assignment. Runnable from a fresh shell:

```bash
# Protected backup location. 0700 directory, 0600 files -- the backup of a secret-bearing file must
# not inherit the target's more permissive 0640.
BK=~/env-backup
mkdir -p "$BK" && chmod 700 "$BK"
install -m 600 /dev/null "$BK/web.env.bak"
sudo cat /etc/avenlyo/web.env > "$BK/web.env.bak"     # 0600 already set by install

# Edit through a private temp file, then install with the TARGET's owner/group/mode.
T=$(mktemp); chmod 600 "$T"
sudo sed '/^AVENLYO_API_URL=/d' /etc/avenlyo/web.env > "$T"
sudo install -o avenlyo -g avenlyo -m 640 "$T" /etc/avenlyo/web.env
rm -f "$T"
```

**Verify silently.** Never `diff` two secret-bearing env files: if an unintended second change
slipped in, `diff` prints the changed secret to your terminal — and to your scrollback, and to
whatever you paste it into. Compare filtered copies instead, and let the exit code speak:

```bash
# 1. The key count moved exactly 1 -> 0.
before=$(grep -c '^AVENLYO_API_URL=' "$BK/web.env.bak")
after=$(sudo grep -c '^AVENLYO_API_URL=' /etc/avenlyo/web.env || true)
test "$before" = "1" && test "$after" = "0" || { echo "unexpected AVENLYO_API_URL key count"; false; }

# 2. Every other byte is unchanged -- compared with the same line removed from both sides, so the
#    only difference the comparison can see is the one that was intended. cmp -s prints nothing.
A=$(mktemp); B=$(mktemp); chmod 600 "$A" "$B"
grep -v '^AVENLYO_API_URL=' "$BK/web.env.bak" > "$A"
sudo grep -v '^AVENLYO_API_URL=' /etc/avenlyo/web.env > "$B"
cmp -s "$A" "$B" && echo "verified: only the AVENLYO_API_URL assignment changed" \
                || echo "REFUSED: something else changed -- restore from the backup"
rm -f "$A" "$B"
```

Both steps print a fixed sentence or a count and never a value. The second exits non-zero on any
unintended change without revealing what changed; if it refuses, restore from `$BK/web.env.bak` and
investigate before deploying.

The stale line is inert once `deploy/compose.yaml` supplies `AVENLYO_API_URL` — Compose's
`environment:` overrides `env_file:` — but it is a second authority for a security-relevant value,
and the next person to read the file has no way to know which one won. Remove it.

### Adding the deployment identity to api.env

Same rules: back up first, append only, verify by count and silent comparison.

```bash
BK=~/env-backup
mkdir -p "$BK" && chmod 700 "$BK"
install -m 600 /dev/null "$BK/api.env.bak"
sudo cat /etc/avenlyo/api.env > "$BK/api.env.bak"

T=$(mktemp); chmod 600 "$T"
sudo cat /etc/avenlyo/api.env > "$T"
echo 'AVENLYO_DEPLOYMENT_ENV=staging' >> "$T"          # or production
sudo install -o avenlyo -g avenlyo -m 640 "$T" /etc/avenlyo/api.env
rm -f "$T"

# Verify: the key appeared exactly once, and nothing else moved.
test "$(sudo grep -c '^AVENLYO_DEPLOYMENT_ENV=' /etc/avenlyo/api.env)" = "1" \
  || { echo "unexpected AVENLYO_DEPLOYMENT_ENV key count"; false; }
A=$(mktemp); B=$(mktemp); chmod 600 "$A" "$B"
grep -v '^AVENLYO_DEPLOYMENT_ENV=' "$BK/api.env.bak" > "$A"
sudo grep -v '^AVENLYO_DEPLOYMENT_ENV=' /etc/avenlyo/api.env > "$B"
cmp -s "$A" "$B" && echo "verified: only the deployment identity was added" \
                || echo "REFUSED: something else changed -- restore from the backup"
rm -f "$A" "$B"
```

It must match the profile's `AVENLYO_DEPLOYMENT_ENV`; `ops:preflight` fails the deployment if the
two disagree. Keep both backups until the deployment is verified — they are the rollback for a
configuration mistake, and they contain secrets, so keep them at 0600 inside a 0700 directory and
delete them deliberately when the host is stable.

### Why a one-off container and not `pnpm ops:preflight`

This used to be documented as a host command, and that was not an executable contract:

- A host shell does not receive `/etc/avenlyo/api.env`. Compose does, through `env_file:`.
- A host shell does not receive the `AVENLYO_PROFILE_*` values. Compose injects those from the
  `--env-file`.
- A deployment host is not guaranteed to hold a source checkout or a built `dist/` at all.

So a host invocation either failed to start or validated a different profile from the one being
deployed. The one-off container is the same image, the same compose file, the same `--env-file` and
the same server env file the deployment itself runs with — which is the only arrangement in which
"preflight passed" is a statement about this deployment.

`--no-deps` keeps web and Caddy down; `--rm` leaves nothing behind. `docker compose run` has **no**
`--no-build` flag, and it will build an image that is missing — which is why the `docker image
inspect` above is part of the command and not a nicety: with the exact tag provably present, the run
cannot build anything. CI asserts this by comparing the image ID before and after.

### What it checks

- The deployment environment resolves, and a production-mode process actually declared one.
- **The deployment profile is present at all**: `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_AVENLYO_API_URL`,
  `AVENLYO_WEB_HOST`, `AVENLYO_API_HOST`, `AVENLYO_API_URL` and the profile's own
  `AVENLYO_DEPLOYMENT_ENV`. A missing value fails; it does not quietly skip the agreement that value
  was there to prove.
- **The profile's declared environment matches the API's own.** `/etc/avenlyo/api.env` and the
  `--env-file` are two files an operator edits separately; a container declaring production while
  rendered from the staging profile is a cross-wire neither file can detect alone.
- `AVENLYO_RELEASE` is an exact commit SHA.
- The web container's API path is the internal `http://caddy:8080` boundary.
- Public URLs use HTTPS and agree with each other: `NEXT_PUBLIC_APP_URL`, `API_CORS_ORIGIN`, and
  `WEB_CHAT_IFRAME_ORIGIN` name the same origin, and `NEXT_PUBLIC_AVENLYO_API_URL` matches the API
  hostname. A drift between the CORS origin and the app origin is a security defect, not a typo.
- No staging hostname appears in a production configuration, and no production hostname in staging.
- `STRIPE_MODE` is not `test` in production.
- Public URLs name a port Caddy actually publishes. Only `443` is served, so a URL on `:8443`
  describes an endpoint nothing listens on — and every hostname check would still pass it.
- **Provider callbacks address this deployment.** When configured, `GOOGLE_OAUTH_REDIRECT_URI` must
  use the public API origin plus the route the API actually serves,
  `/v1/scheduling/google-calendar/callback`, with no query or fragment; and
  `TWILIO_MESSAGING_WEBHOOK_BASE_URL` must use the public API origin with no path prefix, because the
  webhook routes are absolute and a prefix builds a URL nothing routes. HTTPS alone was never enough:
  an unrelated HTTPS host is a login that dead-ends after the user has consented, and inbound
  messages that simply never arrive.
- **The Supabase URL is a hosted Supabase project.** The declared expectation is compared against the
  ref in `https://<project-ref>.supabase.co`. An arbitrary domain whose first DNS label happens to
  equal the expectation is a mismatch, not a match.
- Required capabilities are configured, and no capability is `partial`. A half-configured
  integration fails; one cleanly disabled passes.
- The database is reachable and the schema is at least the required version.

### Where the values it checks come from

Preflight runs inside the API container, which by itself holds only the server-side half of the
profile. The browser-facing half — `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_AVENLYO_API_URL`,
`AVENLYO_WEB_HOST`, `AVENLYO_API_HOST`, `AVENLYO_API_URL`, and the profile's own
`AVENLYO_DEPLOYMENT_ENV` — is passed into the container by `deploy/compose.yaml` as
`AVENLYO_PROFILE_*`, from **the same `--env-file` the build and the rest of the deployment read**.

That sameness is the point. A separate file for preflight to read would be a second source of truth,
and preflight would end up certifying a profile the deployment did not use. Every one of these
values is non-secret; no key, token, or anon key belongs in that block.

`AVENLYO_API_URL` is the case where this mattered most. It used to live in `/etc/avenlyo/web.env`
while preflight validated the profile's copy, so preflight could certify `http://caddy:8080` while
the running web container reached `api:4000` directly — the exact bypass of the one-hop trust
boundary the value exists to prevent. `deploy/compose.yaml` now wires the web service's runtime
`AVENLYO_API_URL` from the profile, and `web.env.example` no longer declares it.

The runtime `AVENLYO_DEPLOYMENT_ENV` is deliberately **not** passed from the profile. Compose's
`environment:` overrides `env_file:`, so that would let the profile silently replace the identity
`api.env` supplies. The profile's copy is mirrored under `AVENLYO_PROFILE_DEPLOYMENT_ENV` instead,
and the two are compared.

### What is fail-closed

A deployed preflight must not exit `0` while something it is supposed to prove is unproven:

| Condition | development | staging | production |
| --- | --- | --- | --- |
| Schema probe did not answer | skip | **fail** | **fail** |
| Schema older than required | fail | **fail** | **fail** |
| Schema >= required | pass | pass | pass |
| Required profile setting absent | skip | **fail** | **fail** |
| Profile identity ≠ runtime identity | skip | **fail** | **fail** |
| Provider callback misaligned (when configured) | skip | **fail** | **fail** |
| Supabase project ref undeclared | skip | skip (unverified) | **fail** |
| Supabase ref declared, mismatched | fail | **fail** | **fail** |
| Supabase ref declared, URL not a hosted project | fail | **fail** | **fail** |

Development is permissive throughout: there is no deployment profile, no Caddy and no compose network
locally, so requiring one would make the command unusable where an engineer actually runs it.

A run whose database did not answer has established nothing about schema compatibility, so exiting 0
would wave through precisely the case the check exists for. The `>=` rule is unchanged — a newer
schema passes, which is what keeps additive rollback possible.

The Supabase row is the one asymmetry, and it is deliberate. In production the declaration is
mandatory: a Supabase URL is an opaque ref, so production pointed at the staging database is
invisible unless an operator states which project they meant, and "nobody said" is the unverified
state that must not pass. Staging keeps the softer policy because it is the environment where the
project may legitimately be rebuilt; there an undeclared expectation is reported as unverified.

Exit codes: `0` all checks passed, `1` a check failed, `2` the configuration could not be parsed at
all. `2` means the environment is malformed rather than merely wrong — a missing or invalid
`AVENLYO_DEPLOYMENT_ENV`, for instance. It prints bounded fixed text, never a stack trace.

Findings name the **setting**, never its value, so preflight output is safe to paste into a ticket.

## External monitoring

The minimum a deployment needs watched from outside the host. Everything below is a public endpoint
requiring no credential.

| Check                      | Signal                                            | Interval |
| -------------------------- | ------------------------------------------------- | -------- |
| `GET /health/live` (API)   | The process is serving HTTP                       | 1 min    |
| `GET /health/ready` (API)  | This replica can take traffic                     | 1 min    |
| `GET /api/health` (web)    | The Next.js server is serving                     | 1 min    |
| TLS certificate expiry     | Both public hostnames, alert at 14 days remaining | daily    |
| DNS resolution             | Both public hostnames resolve to the expected host | daily   |

Why external: a monitor running on the host it monitors reports healthy right up until the host is
the thing that failed.

Alerting judgement:

- **Alert on `/health/ready` failing for several consecutive checks**, not on a single one. A single
  503 is expected during a deploy and during graceful shutdown.
- **Do not alert on `429`.** That is a limit working.
- **Do not alert on queue depth.** Queues are not meant to be empty; the signal is the oldest due
  item getting older across consecutive checks, which is read through `ops:status`.
- A component reporting `STALE` in `ops:status` deserves attention. It is runtime failure detection,
  not a customer service-level objective — Avenlyo defines none.

Avenlyo ships no monitoring credentials and configures no monitoring provider. Wiring the checks
above into whichever provider is used is a deployment step, not a code change.

## ops:status

On a deployment host, inside the running API container — no Node or pnpm needed:

```bash
docker compose --env-file deploy/env/build.env -f deploy/compose.yaml \
  exec -T api node dist/scripts/ops-status.js            # human readable

docker compose --env-file deploy/env/build.env -f deploy/compose.yaml \
  exec -T api node dist/scripts/ops-status.js --json     # machine readable
```

Locally, against a development environment, `pnpm ops:status` and `pnpm ops:status --json` are the
same command through the workspace script. That form is **local only**: the production image ships
`dist/` and no `tsx`, and deployment hosts have no Node runtime.

Requires the trusted server Supabase environment (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). It is
a CLI and not an HTTP route on purpose: Avenlyo has tenant authorization and no platform-staff role
system, and adding a hidden super-admin page would be pretending to have security that does not
exist.

It prints global aggregates only — no tenant, contact, phone number, message body, transcript, or
provider identifier — plus the capability doctor and runtime heartbeats.

Exit codes: `0` healthy, `1` database unreachable, `2` schema incompatible.

### Capability states

- `configured` — every setting the capability needs is present.
- `disabled` — the operator clearly never enabled it. This is normal and does not block readiness.
- `partial` — some settings present, others missing. **This fails readiness.** A half-configured
  provider is not a disabled provider; it is a deployment that will fail somewhere later, so it is
  surfaced loudly instead of being silently switched off.

## Runtime heartbeats

Each API process registers an ephemeral `runtime_instance_id` at start and writes a bounded
heartbeat roughly every 25 seconds per component. Components are `message_processing`,
`appointment_reminders`, `lead_followups`, `billing_events`, and `knowledge_imports`.

`knowledge_imports` only runs where the knowledge runtime is configured. Where it is not, its absence
is correct and is not a missing component.

Multiple replicas reporting at once is expected and correct. Durable claim and idempotency semantics
— not process identity — decide who may do work, so no leader election exists and none is needed.

Reading heartbeats:

- **A tick that found no work is a success.** An idle deployment shows recent successes and zero
  failures. "No work" is healthy.
- **`consecutive_failures` above zero** with a bounded `last_error_code` means that component's ticks
  are failing. A single failed job does not make the replica unready — the durable queue already
  carries that truth — but a rising streak needs attention.
- **`STALE`** means the component has not reported a success within several heartbeat intervals. That
  is runtime failure detection using a deterministic multiple of the configured interval. It is not
  a customer service-level objective; Avenlyo defines none.
- **`stopped`** is an intentional shutdown, never counted as active.

Retention: stopped instances are removed after 2 days, and instances that stopped reporting entirely
are removed after 7 days. A recently silent instance is deliberately kept, because silence is itself
the diagnosis.

## Queue backlog interpretation

`ops:status` reports counts and the age of the oldest item in each state. Work scheduled for the
future is reported separately from work that is currently due, so tomorrow's reminder is never
counted as a backlog.

Queues do not need to be zero. Judge by whether the oldest due item is getting older across
consecutive checks.

## Graceful shutdown

On `SIGTERM` or `SIGINT` the process marks itself draining first — so readiness returns 503 and the
load balancer removes the replica while it can still finish accepted work — then stops worker loops
from claiming, awaits in-flight ticks, drains HTTP, and writes a final stopped heartbeat.

Shutdown is idempotent. A second signal joins the first sequence instead of starting another, so no
cleanup or provider mutation is ever duplicated. A bounded timer exists only so a wedged operation
cannot hold the process open forever.

If startup fails to bind its port, worker runtimes are still stopped, so no orphaned timer loop is
left behind.

## Database outage

Expected behaviour:

- `/health/live` keeps returning `200`. The process is alive; there is nothing to restart.
- `/health/ready` returns `503`, so traffic drains away from every replica.
- Workers stop making durable progress. They keep polling on their normal interval and do not spin.
- Heartbeat writes fail, are logged, and retry on the next interval rather than crashing the process.

Do not manually mutate tables to "unstick" anything. When the database recovers, durable workers
resume claiming with their existing lease and idempotency semantics, and no blind retry assumption is
made about work that was in flight.

## Message job backlog

Check `message_jobs` in `ops:status`: `queued`, `processing`, `failed`, and `expired_lease`.

`expired_lease` counts jobs whose worker claim is older than the recovery window; the existing claim
path recovers them on the next poll. A persistent backlog usually means no worker is running (check
runtime heartbeats) or the agent/provider configuration is `partial`.

## Unknown SMS delivery

`unknown` means the provider submission outcome is genuinely ambiguous: Avenlyo may have posted the
message to Twilio and lost the response.

**Do not resend.** A blind resend can deliver the same message twice to a customer. This is a Phase 7
invariant: once a delivery has crossed the submission boundary, provider truth wins and the handoff,
reminder, and follow-up lifecycles never rewrite `submitting`, `submitted`, `sent`, `delivered`,
`unknown`, `failed`, or `undelivered`.

To resolve one, inspect the message in the Twilio console or via supported provider tooling. If the
customer needs a reply, a staff member can send one through the Inbox, which creates a new, deliberate
outbound message rather than a duplicate of an ambiguous one.

## Booking `provider_state_unknown`

The same rule applies to scheduling. `provider_state_unknown` on a booking intent or an appointment
change intent means Avenlyo could not confirm whether the provider write landed.

**Do not create a replacement booking.** Doing so risks double-booking a real customer. The existing
reconciliation and handoff behaviour is the supported path: the conversation is escalated to a person
who can check the provider calendar and act deliberately.

## Stripe webhook backlog

A signed Stripe event is durably accepted the moment it is verified, so a backlog in
`billing_events` means the worker has not processed events yet — not that events were lost.

Inspect `pending`, `processing`, `failed`, and the oldest age. **Do not mark events processed to
clear the queue**: that discards billing truth, and since Phase 17 it would also change what
customer automation is permitted to do.

A backlog delays a billing transition; it does not by itself mutate product state, and the runtime
never pings Stripe to compensate. Whatever billing state was last durably applied is the one that
controls new entitlement claims until the worker catches up. If a backlog is holding a customer in
the wrong state, fix the worker: let reconciliation apply provider truth.

## Billing entitlement enforcement (Phase 17)

Billing is no longer observational. The last durably applied billing projection controls whether a
new customer-automation claim may cross into paid provider or model work.

**Entitlement matrix.** One organization, one billing account, one Avenlyo Core subscription. Every
Core feature — voice, sms, web_chat, appointments, lead_capture, reminders, lead_followups —
answers together:

| Normalized billing state | New paid automation | Why                                                                   |
| ------------------------ | ------------------- | --------------------------------------------------------------------- |
| `active`                 | allowed             | supported Core subscription, provider status active or trialing       |
| `attention`              | allowed             | `past_due` is a recoverable payment problem, not a suspension         |
| `inactive`               | unavailable         | `unpaid`, `paused`, `incomplete`, or no current subscription          |
| `review_required`        | unavailable         | unsupported product, unknown status, or several current subscriptions |
| `unconfigured`           | unavailable         | no billing account                                                    |

A supported Stripe trial is entitled. A subscription with `cancel_at_period_end` set stays entitled
until the provider actually moves it to a terminal state. Ambiguous topology always fails closed;
Avenlyo never guesses that one of several subscriptions is probably the right one.

**Where it is decided.** At the durable execution claim, inside the same transaction that takes the
claim: the message-job claim, the Twilio submission claim, the inbound voice bootstrap, the web-chat
session and message RPCs, the booking provider-write claim, the reminder due-work claim, the
follow-up claim, and automated lead capture. Nothing calls Stripe to answer it, so Stripe
reachability is not part of health, readiness, or any per-message, per-call, or per-booking
decision, and a Stripe outage cannot suspend otherwise-active customers.

**What suspension blocks.** New AI replies, new outbound SMS, new inbound voice sessions, new web
chat sessions and visitor messages, new automated bookings, new reminders, new follow-ups, new
automated lead capture, and new staff replies to customers.

**What keeps working.** Everything that is not new paid execution. Dashboard, Customers, Customer
360, Conversations, transcripts, Leads, Appointments, Inbox and Team all stay readable. Claim,
Release, Resolve and Take over stay available, so operators can still clean up existing work.
Inbound SMS is still received and persisted, so customer history stays accurate. STOP always takes
effect, and START and HELP keep their deterministic consent semantics — consent handling runs at
ingestion, before entitlement is ever consulted. Owners and admins keep configuring Voice, Web Chat,
SMS routing and scheduling integrations; a billing transition never rewrites a configuration flag.

**Terminal suppression, and no replay.** Blocked work is not failed and not retried: it reaches a
deliberate terminal disposition with the bounded reason `billing_unavailable` — a `suppressed`
message job, a `suppressed` delivery, a `skipped` reminder or follow-up, a `rejected` voice webhook
event. Suppressed work is never re-claimed, so reactivating billing releases no backlog: no old AI
reply, reminder, follow-up, or staff message is sent afterwards. Reactivation permits new eligible
work only.

**Ambiguous provider truth is untouchable.** An `unknown` SMS delivery, a `provider_state_unknown`
booking, and a `provider_success_pending_persistence` booking all keep their meaning. Billing never
rewrites a state that may already have crossed a provider boundary, and booking recovery and
reconciliation stay available so a prior attempt's outcome can still be discovered and persisted.
Recovery may perform a read-only provider reconciliation; it never creates a replacement booking.

**Billing mutations and the selected workspace.** Checkout, Portal, and Refresh are bound to the
workspace the caller is selected into, not merely to an organization they administer. The Next.js
server signs the resolved selection with `AVENLYO_INTERNAL_BILLING_SECRET` and the API verifies it
against the identity in the bearer token. Both servers must hold the same value, it must be at
least 32 characters, and it must never carry a `NEXT_PUBLIC_` name.

If owners report that Subscribe, Manage billing, or Refresh status does nothing, check that secret
on both sides first: a mismatch or an unset value fails these three routes closed with
`BILLING_WORKSPACE_UNVERIFIED` and touches neither the database nor Stripe. Nothing else in the
product depends on it — Voice, SMS, Web Chat, reminders, follow-ups, readiness, and every read
surface are unaffected. Rotate it by setting the new value on both servers; in-flight proofs expire
within two minutes, so a brief overlap is all a rolling deploy needs.

**Operational reading.** `ops:status` reports a `billing_suppression` metric group — message
jobs, SMS deliveries, reminders, follow-ups, and voice rejections. These are global aggregates with
no tenant, location, customer, or message identity, and they are business-state diagnostics: a
non-zero value is a correctly declined operation, not a process, database, or provider failure. A
worker that suppresses unentitled work is healthy and reports a successful heartbeat. One
organization's inactive subscription never makes `/health/ready` answer 503.

## Safe restart expectations

Restarting an API process is safe. Workers hold durable leases, claims are idempotent, and shutdown
drains before exiting. Expect a brief readiness dip on the restarting replica only, and expect a new
`runtime_instance_id` afterwards — the previous instance stays visible as `stopped` for a couple of
days.

## Secret operations

- Server secrets live in the deployment platform's secret storage, never in the repository.
- Never commit `.env` or `.env.local`.
- Never paste a service-role key into a browser, and never place a provider key in a
  `NEXT_PUBLIC_` variable — those are shipped to every visitor.
- Never log production environment values. Health responses, structured logs, the operational
  snapshot, and `ops:status` are all designed so no key, token, signature, or connection string can
  appear in them.
- Rotating a secret is a deployment change: update the secret store, then redeploy.

## Deployment checklist

Before:

- [ ] Provider console shows backup/PITR enabled and current
- [ ] `AVENLYO_DEPLOYMENT_ENV` is set to this environment, in **both** `deploy/env/build.env` and
      `/etc/avenlyo/api.env`, to the same value
- [ ] `docker compose ... config --quiet` exits 0 and prints nothing on the host
- [ ] CI is green on the exact release SHA (that is what discharges the source/topology assertion)
- [ ] `sudo grep -c '^AVENLYO_API_URL=' /etc/avenlyo/web.env` is `0` (obsolete authority removed)
- [ ] `AVENLYO_RELEASE` is the exact 40-character commit SHA being deployed
- [ ] Images are tagged with that SHA and already built, and `docker image inspect` confirms it
- [ ] The one-off preflight container exits 0 (schema check aside, until migrations run)

During:

- [ ] Migrations applied **before** the new application code
- [ ] `platform_schema_contract` is at least 19
- [ ] The one-off preflight container re-run exits 0 with no exception
- [ ] Deployed with `up -d --no-build`

After:

- [ ] `GET /health/live` returns 200 on every replica
- [ ] `GET /health/ready` returns 200 on every replica
- [ ] Web `GET /api/health` returns 200
- [ ] The one-off `smoke-production.js` container exits 0, including `api_release`
- [ ] `ops-status.js` in the running api container exits 0
- [ ] No capability reports `partial`
- [ ] Expected worker components are visible and reporting recent successes
- [ ] No unexpected growth in the oldest due item of any queue

Queues do not have to be empty to proceed.
