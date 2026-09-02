# Phase 23 staging pre-deploy gate

This is the operator plan for promoting the merged Phase 23 Agent Operating Model to the existing
Hetzner staging environment. It is deliberately a **pre-deploy** document: following the read-only
gates below must not change the hosted staging database, recreate containers, or touch production.

## Exact source candidate

The Phase 23 implementation was squash-merged by PR #31.

- source branch head before merge: `b9cdad77abc433aad64cc0f9c3fc6e2affb66237`
- merged `main` commit: `565e7c4597102c32e548a45818e6aa2b1a31b508`
- post-merge `main` CI: run #368, all six required jobs passed
- application-required schema: **22**

Do not substitute a newer `main` commit during an operator run. If `main` moves, stop and review the
new diff/CI before choosing a new exact release candidate.

## Known staging starting point

The last independently verified staging state is the Phase 21A release:

- serving release: `be199775a1f7e89292ad768d4746c817f9bdd4e5`
- hosted schema: **19**
- deployment identity: `staging`

That evidence is historical, not a Phase 23 acceptance result. The Phase 23 binary refuses readiness
below schema 22, so the old schema 19 database must be upgraded before the Phase 23 containers can be
promoted.

## Database migration inventory: schema 19 -> 22

Hosted staging already has `20260901000000_phase_19_web_chat_poll_bounds.sql`. The exact merged Phase
23 source adds the following **11** later migrations, in timestamp order:

1. `20260901010000_phase_23_agent_work_state.sql`
2. `20260901020000_phase_23_provider_mutation_ownership.sql`
3. `20260901030000_phase_23_correction_invalidation.sql`
4. `20260901040000_phase_23_lifecycle_prepare_hardening.sql`
5. `20260901050000_phase_23_booking_prepare_hardening.sql`
6. `20260901060000_phase_23_voice_handoff_terminal_control.sql`
7. `20260901070000_phase_23_confirmation_presentation.sql`
8. `20260901080000_phase_23_confirmation_transition_guard.sql`
9. `20260901090000_phase_23_confirmation_visibility_hardening.sql`
10. `20260901100000_phase_23_confirmation_visibility_ordering.sql`
11. `20260901110000_phase_23_provider_outcome_retry_hardening.sql`

The final migration declares schema 22 only after provider-uncertainty/retry hardening is installed.
Schemas 20 and 21 are intentionally incomplete intermediate Phase 23 states and the current binary
must not report ready against them.

Phase 23 keeps stable rollback call shapes and hardens the old work-state path fail-closed. Therefore
the intended sequence is **database first, containers second**: the existing older staging image may
continue serving while the additive schema is advanced, while the new image cannot safely serve
before the schema reaches 22.

## Gate A — source and CI proof (read-only)

Required before touching the hosted database:

```bash
TARGET="565e7c4597102c32e548a45818e6aa2b1a31b508"

git fetch origin main
git checkout --detach "$TARGET"
test "$(git rev-parse HEAD)" = "$TARGET"
test -z "$(git status --porcelain --untracked-files=no)"
```

Independently verify GitHub CI run #368 is `success` for this exact SHA and that all six required jobs
passed:

- Application checks
- API production artifact
- Deployment contract
- Rendered browser security
- Database security tests
- Hetzner staging container validation

If any exact-SHA check is missing or no longer trusted, stop.

## Gate B — staging project identity and remote migration history (read-only)

Run this on the trusted operator workstation that already has the Supabase CLI and staging project
access. Do not run it against production.

```bash
# Link only to the known staging project ref. Do not paste the production ref here.
supabase link --project-ref <STAGING_PROJECT_REF>

# Read-only inventory. Confirm the remote history stops at Phase 19 before the planned push.
supabase migration list
```

Expected precondition:

- `20260901000000` is already present remotely.
- none of `20260901010000` through `20260901110000` is partially/apparently applied in a divergent
  state.
- no unexpected remote-only migration exists after Phase 19.

If the remote history does not match this precondition, **do not run `supabase db push`**. First
reconcile why staging differs from the known Phase 21A evidence.

## Gate C — backup / recovery checkpoint

Before any hosted migration, create or verify the staging backup/checkpoint required by the team's
standard Supabase practice. Record enough operator evidence to identify the checkpoint without
copying database credentials or customer data into the repository/chat.

This gate is mandatory even though the Phase 23 migrations passed a full local migration reset and
pgTAP suite in CI.

## Gate D — host preconditions (read-only)

On the Hetzner staging host, do not build or recreate containers yet:

```bash
set -euo pipefail
cd /opt/avenlyo

TARGET="565e7c4597102c32e548a45818e6aa2b1a31b508"

git fetch origin main
git checkout --detach "$TARGET"
test "$(git rev-parse HEAD)" = "$TARGET"
test -z "$(git status --porcelain --untracked-files=no)"

# Preserve the existing staging profile contract. Do not print build.env.
test "$(grep -c '^AVENLYO_DEPLOYMENT_ENV=' deploy/env/build.env || true)" -eq 1
grep -qx 'AVENLYO_DEPLOYMENT_ENV=staging' deploy/env/build.env
grep -qx 'AVENLYO_API_URL=http://caddy:8080' deploy/env/build.env
grep -qE '^AVENLYO_EXPECTED_SUPABASE_PROJECT_REF=[a-z0-9]{20}$' deploy/env/build.env

# Secret-safe Compose validation. `config --quiet` must print nothing.
docker compose --env-file deploy/env/build.env -f deploy/compose.yaml config --quiet
```

Also record the currently serving release from the public API before migration/deploy. It should
still be the known Phase 21A release unless a separately reviewed staging change happened after the
last evidence.

## STOP — explicit migration authorization required

Everything above is inspection/planning. **Do not continue automatically.**

The next consequential command is:

```bash
supabase db push
```

It mutates the hosted staging database and requires explicit operator/user authorization after Gates
A-D are reviewed.

When authorization is given, perform the migration from the exact source checkout linked to the
staging Supabase project only. Immediately verify the remote migration history and the readiness
probe reports schema 22 before building/deploying the new containers.

## Post-migration / pre-container gate

After an authorized successful migration, but before replacing the running containers:

1. verify all 11 Phase 23 migration versions are present remotely;
2. verify `platform_readiness_probe` reports schema 22;
3. verify the existing Phase 21A deployment remains live/ready on the newer additive schema;
4. if the old deployment becomes unhealthy, stop and investigate before attempting to hide the
   problem with a new container deployment.

This is the rollback-compatibility proof that the database-first sequence depends on.

## Container promotion — separate authorization boundary

Only after the database gate is clean should the host build/promote the exact merged SHA using the
existing `docs/deployment/hetzner-staging.md` procedure:

```bash
export AVENLYO_RELEASE="565e7c4597102c32e548a45818e6aa2b1a31b508"

docker compose --env-file deploy/env/build.env -f deploy/compose.yaml build

docker image inspect "avenlyo-api:${AVENLYO_RELEASE}" > /dev/null
docker image inspect "avenlyo-web:${AVENLYO_RELEASE}" > /dev/null

docker compose --env-file deploy/env/build.env -f deploy/compose.yaml \
  run --rm --no-deps -T api node dist/scripts/ops-preflight.js

# STOP again for deployment authorization.

docker compose --env-file deploy/env/build.env -f deploy/compose.yaml \
  up -d --no-build --wait web api caddy
```

Do not combine migration authorization and container-promotion authorization into one assumed step.
The database-first compatibility gate must be observed between them.

## Required Phase 23 post-deploy proof

A successful container start is not Phase 23 staging acceptance. At minimum verify:

- public API `/health/live` exact release = merged Phase 23 SHA;
- public API `/health/ready` = ready and schema 22 compatible;
- public web `/api/health` = ok and exact release;
- `smoke-production.js` passes including exact API release;
- `ops-status.js` reports one active runtime, no stale runtime, and no expired message-job leases;
- Chromium sandbox smoke still passes as non-root UID 10001;
- capability report still reflects the deliberately configured staging providers (do not enable a
  disabled provider merely for the deploy);
- no production endpoint, DNS, credential, or hosted production database was touched.

After those infrastructure/runtime checks, run the focused real-staging Phase 23 product acceptance
scenarios separately. Production readiness remains a later gate.
