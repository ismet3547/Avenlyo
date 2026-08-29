# Production readiness gate — 2026-08-29

This is a **readiness record, not a production deployment authorization**. It is based on the
Phase 21A real-staging verification, the repository state after PR #28, and read-only inspection of
the production deployment contract. No production host, DNS, Supabase project, provider account,
credential, hosted production data, or production deployment is created or changed by this record.

## Gate result

**PRODUCTION DEPLOYMENT: BLOCKED**

The application/deployment candidate has strong staging and CI evidence, and repository release
governance is now enforced. Production is still not ready to deploy because the real
infrastructure/account prerequisites are intentionally absent.

This is a useful result: the remaining work is now bounded and explicit rather than mixed together
with application correctness.

## Runtime candidate

The production runtime candidate is:

`be199775a1f7e89292ad768d4746c817f9bdd4e5`

It is intentionally **not** the current documentation-only `main` HEAD
`9069cfb048aa45fcf87841e2426203418f06d300`.

Reason:

- `be199775...` is the exact release that was built, preflighted, deployed, smoke-tested and observed
  on the real Hetzner staging runtime;
- its post-merge CI run `33216352775` completed successfully across all six expected jobs;
- the real staging re-promotion proved the corrected Supabase EXPECTED/profile versus
  ACTUAL/`SUPABASE_URL` authority split on that exact release;
- `9069cfb...` is one commit ahead and changes only
  `docs/deployment/hetzner-staging.md` plus the Phase 21A staging evidence file.

The repository's build-once / exact-release model exists so production does not silently receive a
runtime SHA that was never promoted through real staging. Therefore:

> Any code, deployment, dependency, migration, runtime-config contract, Dockerfile, Compose, Caddy,
> or workflow change after `be199775...` invalidates this candidate. A new runtime candidate must
> pass CI and real staging promotion again before production is considered.

Documentation-only changes do not change the staged runtime candidate, but they do not turn their
own commit SHA into a staged release either.

## Evidence already satisfied

### CI and artifact contract

For `be199775...`, post-merge CI run `33216352775` passed all six expected jobs:

1. Application checks
2. API production artifact
3. Deployment contract
4. Rendered browser security
5. Hetzner staging container validation
6. Database security tests

The deployment contract includes production-profile rendering and negative injections for the
cross-environment and provenance defects that matter at go-live, including:

- profile/runtime deployment identity mismatch;
- missing required production profile settings;
- staging hostnames in production;
- web/API network merge;
- web API path bypassing Caddy;
- expected Supabase project ref missing or sourced from the wrong authority;
- expected project ref disagreeing with the runtime hosted Supabase URL;
- exact release/image contract;
- non-root API and sandboxed Chromium container behavior.

### Real staging evidence

Phase 21A real staging was verified on `be199775...` with:

- exact SHA-tagged API and web images built before deployment;
- `docker compose ... config --quiet` PASS;
- one-off exact-image `ops-preflight` PASS;
- schema contract **19** (`requires >= 19`);
- profile EXPECTED Supabase project identity matching the project derived independently from runtime
  `SUPABASE_URL`, without printing either value;
- retired runtime `AVENLYO_EXPECTED_SUPABASE_PROJECT_REF` removed from `/etc/avenlyo/api.env`;
- `up -d --no-build --wait web api caddy` PASS;
- post-deploy smoke `api_live`, `api_ready`, `web_live`, `api_release` PASS;
- public health endpoints serving the exact candidate release;
- `ops-status` PASS with one active runtime, zero stale runtimes, zero expired message-job leases,
  zero due reminders/follow-ups and zero provider-state-unknown booking intents at observation time;
- Chromium running as UID `10001` with sandbox enabled.

The detailed host evidence is in
`docs/deployment/phase-21a-staging-verification-2026-08-29.md`.

### Repository closure after staging

PR #28 was independently reviewed, squash-merged, and its `main` push CI run `33247916310` passed
all six expected jobs. That commit is documentation-only and does not replace the runtime candidate.

## Resolved finding 1 — repository release governance

The first read-only GitHub inspection on 2026-08-29 reported:

- `main`: `protected=false`;
- required status checks enforcement: `off`;
- repository rulesets: none.

That was a production-readiness blocker because a green voluntary CI run was not equivalent to an
enforced merge gate.

A legacy branch-protection rule was first created and tightened. The final solo-maintainer governance
state was then moved to an active repository ruleset targeting `refs/heads/main`. Independent GitHub
API readback of that ruleset reports:

- enforcement: `active`;
- pull requests are required before merging;
- required approving review count: `0`, avoiding a solo-maintainer approval deadlock;
- all six expected GitHub Actions checks are required:
  - `Application checks`;
  - `API production artifact`;
  - `Deployment contract`;
  - `Rendered browser security`;
  - `Hetzner staging container validation`;
  - `Database security tests`;
- branch deletion is blocked;
- non-fast-forward updates are blocked;
- bypass actors: none;
- the current administrator cannot bypass the ruleset.

The earlier legacy branch-protection rule is fully covered by the ruleset and is no longer the
authoritative release-governance mechanism. The important release property is unchanged: `main`
can only advance through a pull request whose required CI checks pass, without an administrator
bypass path.

**Result: repository release-governance blocker RESOLVED.**

## Blocking finding 2 — production infrastructure and accounts do not exist yet

The production contract is present in the repository, but the real production environment has not
been provisioned. Before any deploy command is authorized, all of the following must exist and be
verified independently from staging:

1. **Production host** provisioned and hardened with the same deployment invariants used by staging.
2. **Separate production Supabase project** provisioned. Staging must never be reused.
3. Production Supabase **backup/PITR capability** confirmed enabled and current in the provider
   console before migrations.
4. Final production **API hostname decided**. `api.avenlyo.com` in the template is currently an
   example, not evidence of a chosen or provisioned record.
5. Production web/API **DNS records** created for the actual host.
6. **TLS** successfully obtained after DNS resolves.
7. Production `/etc/avenlyo/api.env` and `/etc/avenlyo/web.env` populated from the server-only
   templates with production credentials only.
8. `AVENLYO_DEPLOYMENT_ENV=production` present exactly once in the API runtime env and in the
   deployment profile, with matching values.
9. `AVENLYO_EXPECTED_SUPABASE_PROJECT_REF` declared exactly once in the public deployment profile
   and absent from `/etc/avenlyo/api.env`.
10. `/etc/avenlyo/web.env` contains no stale `AVENLYO_API_URL`; the deployment profile remains its
    sole authority.
11. Final production capability scope decided: each optional integration is either fully configured
    for production or cleanly disabled — never partial. If Stripe billing is enabled, it must use
    live mode/live credentials; configured Google/Twilio callbacks must point to the final production
    API origin.
12. External monitoring configured for API liveness/readiness, web health, TLS expiry and DNS as
    described in `docs/production-runbook.md`.

These are external/provider actions. They are not satisfied by CI and they must not be inferred from
staging.

## Database gate

The candidate adds no migration and still requires schema contract **19**, but a newly provisioned
production Supabase project starts without the application's schema. Before application deployment:

1. link tooling only to the separately provisioned **production** project after an explicit go-live
   authorization;
2. apply the repository migrations to bring that project to at least schema contract 19;
3. never run a destructive down migration as part of deploy/rollback;
4. re-run the exact-image production preflight and require schema compatibility PASS before
   `docker compose up`.

No production migration has been run by this readiness gate.

## Final pre-deploy gate on the real production host

Once the blockers above are satisfied, but **before** deploying containers:

- check out exact candidate `be199775...` in detached HEAD state;
- confirm the tracked tree is clean;
- assemble `deploy/env/build.env` from the production public profile and build env template without
  printing it;
- set `AVENLYO_RELEASE` to the exact 40-character candidate SHA;
- validate with `docker compose ... config --quiet` only;
- build API/web once under the exact SHA tags;
- prove both exact image tags exist;
- run the exact-image one-off `ops-preflight`;
- require every check PASS after schema 19 is present, including production identity, production
  Supabase identity, capability configuration, callback origins and schema compatibility.

A failed preflight is a **STOP**. Do not deploy around it and do not patch production data/config
manually to make the result green.

## Deployment authorization boundary

Even after every readiness item is green, production deployment remains a separate explicit action.
The authorized deploy must preserve the proven sequence:

- build once under the exact candidate SHA;
- no floating/latest tag;
- deploy with `up -d --no-build --wait`;
- run post-deploy smoke from the exact candidate image;
- prove public `api_release` equals the candidate SHA;
- run `ops-status` inside the serving API container;
- retain the previous immutable image as rollback target;
- rollback by tag switch with `--no-build`, never by rebuilding old source.

## Exit criteria for this readiness gate

This gate may move from **BLOCKED** to **READY FOR EXPLICIT PRODUCTION DEPLOY AUTHORIZATION** only
when all of the following have evidence:

- [x] `main` is governed by an active PR-required ruleset with all six required CI checks and no bypass actor;
- [ ] production host exists and host security baseline is verified;
- [ ] separate production Supabase project exists;
- [ ] backup/PITR is confirmed current;
- [ ] final production API hostname is decided;
- [ ] production DNS resolves to the intended host;
- [ ] TLS is valid for both production hostnames;
- [ ] production server env files are populated with correct ownership/mode and no authority drift;
- [ ] production expected Supabase ref is profile-only and matches runtime `SUPABASE_URL` in
      preflight;
- [ ] provider capability scope is explicitly decided and no capability is partial;
- [ ] external monitoring is configured;
- [ ] production database schema is at least 19;
- [ ] exact candidate images exist and one-off production preflight exits 0;
- [ ] candidate is still `be199775...`, or any replacement candidate has been re-verified through
      CI and real staging.

Until then:

**NO PRODUCTION DEPLOYMENT.**
