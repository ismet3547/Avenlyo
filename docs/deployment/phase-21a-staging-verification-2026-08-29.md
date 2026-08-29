# Phase 21A staging verification — 2026-08-29

This is the operator evidence record for the corrected Phase 21A staging re-promotion.
It records what was actually verified on the real Hetzner staging runtime after the
Supabase project-identity provenance fix was merged.

## Scope

Verified release:

`be199775a1f7e89292ad768d4746c817f9bdd4e5`

Previous serving release before the re-promotion:

`20550ce7204a968f3d3a700ea77b1dbbcb7230c0`

This re-promotion was staging-only. It did not provision or mutate production, production DNS,
production Supabase, provider dashboards, or hosted production data. The hotfix adds no migration;
the required schema contract remains **19**.

## Why this re-promotion was required

The first Phase 21A promotion attempt exposed a deployment-identity provenance defect. The public
deployment profile declared `AVENLYO_EXPECTED_SUPABASE_PROJECT_REF`, but the API container did not
receive that expectation from the profile. The only way to make preflight see it on the real host
was to duplicate the same expected project ref into `/etc/avenlyo/api.env`, which already contains
`SUPABASE_URL`.

That workaround was not an acceptable final state: EXPECTED and ACTUAL Supabase identity could then
come from one authority and agree with each other even if the host were cross-wired.

The merged correction makes the two authorities independent:

- EXPECTED project identity comes from the non-secret deployment profile as
  `AVENLYO_EXPECTED_SUPABASE_PROJECT_REF`;
- Compose mirrors it into the API process under the distinct name
  `AVENLYO_PROFILE_EXPECTED_SUPABASE_PROJECT_REF`;
- ACTUAL project identity comes only from the API runtime `SUPABASE_URL`;
- preflight compares the profile expectation with the project ref derived from the runtime URL;
- the retired runtime `AVENLYO_EXPECTED_SUPABASE_PROJECT_REF` assignment is removed from
  `/etc/avenlyo/api.env`.

## CI gate before host promotion

Post-merge CI for the exact target commit completed successfully before the host promotion.
Run `33216352775` was green across all six expected jobs:

1. Application checks
2. API production artifact
3. Deployment contract
4. Rendered browser security
5. Hetzner staging container validation
6. Database security tests

The host promotion did not begin until that exact merged release had passed CI.

## Secret-safe pre-deploy host gate

The operator checked out the exact 40-character target SHA in detached HEAD state and verified the
tracked tree was clean. The staging deployment profile was updated to the exact release and then
validated without printing the file.

The one-time host cleanup removed exactly one retired
`AVENLYO_EXPECTED_SUPABASE_PROJECT_REF` assignment from `/etc/avenlyo/api.env` using the shipped
fail-closed verifier. The verifier reported:

`verified: only the AVENLYO_EXPECTED_SUPABASE_PROJECT_REF assignment changed (1 -> 0)`

The profile ref was then compared with the project ref derived from the canonical hosted
`SUPABASE_URL` without printing either value. Result:

`Supabase EXPECTED(profile) vs ACTUAL(api.env): MATCH`

Other pre-deploy host results:

- deployment profile: PASS
- existing Phase 20 host env layout: PASS
- retired runtime expected-ref: REMOVED
- `docker compose ... config --quiet`: PASS
- exact SHA API image built and present
- exact SHA web image built and present
- no migration run

The one-off exact-image `ops-preflight` reported schema `19 (requires >= 19)` and passed every
check, including:

- explicit staging deployment environment
- exact commit release
- schema compatibility
- deployment configuration
- optional capability configuration
- Supabase project identity

Final pre-deploy result:

`RESULT: pass`

Nothing had been deployed at that point.

## Real staging re-promotion

The operator deployed only the already-built exact SHA-tagged images using
`up -d --no-build --wait web api caddy`.

All three services became healthy:

- Caddy: healthy
- API: healthy
- web: healthy

No floating or `latest` image tag was used and no build occurred during `up`.

## Post-deploy smoke and exact-release proof

The documented one-off exact API image ran `smoke-production.js` against the public staging
endpoints. Results:

- `api_live`: pass
- `api_ready`: pass
- `web_live`: pass
- `api_release`: pass

An independent public `/health/live` read then confirmed the serving release was exactly:

`be199775a1f7e89292ad768d4746c817f9bdd4e5`

The public endpoint checks also returned the exact same release for:

- API `/health/live` — status `ok`
- API `/health/ready` — status `ready`
- web `/api/health` — status `ok`

## Running operational state

`ops-status` ran inside the real serving API container and exited successfully.

Observed state:

- schema: **19**, requires `>= 19`
- active runtime instances: **1**
- stale runtime instances: **0**
- active release: `be199775a1f7e89292ad768d4746c817f9bdd4e5`
- previous `20550ce7204a968f3d3a700ea77b1dbbcb7230c0` runtime: stopped
- expired message-job leases: **0**
- due reminders: **0**
- due lead followups: **0**
- provider-state-unknown booking intents: **0**
- billing-suppression counters shown by `ops-status`: **0**

Configured capability status remained consistent with the staging posture: OpenAI text and Supabase
core configured; ezyVet, Google Calendar, OpenAI voice, Stripe billing, and Twilio messaging disabled.

## Chromium sandbox proof on the real host

The running API container executed the Chromium sandbox smoke successfully:

- runtime UID: `10001`
- executable: `/opt/avenlyo/chromium/chrome`
- Chromium: `151.0.7922.34`
- sandbox: enabled
- result: PASS

No host security weakening was introduced by this re-promotion.

## Rollback posture

This re-promotion did not rebuild the previous release and did not perform a second rollback drill.
The previous known-good immutable release remains identifiable as
`20550ce7204a968f3d3a700ea77b1dbbcb7230c0`; rollback remains an immutable-image tag switch with
`--no-build`, not a rebuild.

The protected pre-edit API env backup created for the one-time expected-ref cleanup is intentionally
retained until the deployment record is independently reviewed and the staging state is accepted.

## Verdict

**PHASE 21A STAGING VERIFIED — PASS**

The corrected staging deployment proves the intended Supabase identity boundary on the real host:
EXPECTED identity is supplied by the deployment profile, ACTUAL identity is derived from the API
runtime Supabase URL, the retired same-file workaround is absent, and preflight still passes.

This record is evidence for the next production-readiness gate. It is **not** authorization to
provision, configure, migrate, or deploy production.