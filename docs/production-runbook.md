# Avenlyo production runbook

Operational reference for running Avenlyo in production. It covers how to deploy, how to tell
whether a deployment is healthy, and what to do — and deliberately not do — when a queue backs up or
a provider result is ambiguous.

Everything here is observation. Avenlyo never automatically resends an ambiguous SMS, retries an
ambiguous booking, reopens a suppressed follow-up, deletes a failed webhook event, resolves a
handoff, or changes billing state. The Phase 7–13 state machines remain the only authority over
product state, and reading operational status never mutates anything.

## Deployment order

1. **Back up.** Confirm the managed Supabase backup/PITR capability for this project and plan is
   enabled and current. Avenlyo does not ship a home-grown dump scheduler, because that would need
   long-lived service credentials on a host we do not control. Do not claim backups exist unless the
   provider console shows they do.
2. **Apply migrations.** Migrations are additive only; there are no destructive down migrations.
3. **Verify schema readiness.** The database advertises a compatibility version through
   `platform_schema_contract`. Confirm it is at least the version the release requires.
4. **Deploy API and workers.**
5. **Deploy web.**
6. **Run non-destructive smoke checks** (`pnpm smoke:production`).

Application rollback stays possible: readiness requires `database schema >= required`, never
equality, so an older build keeps serving against a newer additive schema.

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

Set `AVENLYO_RELEASE` (a commit SHA is ideal) on both API and web. It appears in health responses,
every structured log line, runtime heartbeats, and `ops:status`. When unset it reports `unknown`,
which is fine locally and a smell in production. It is never generated per request.

## ops:status

```bash
pnpm ops:status          # human readable
pnpm ops:status --json   # machine readable
```

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
`appointment_reminders`, `lead_followups`, and `billing_events`.

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
clear the queue**: that discards billing truth. Billing remains observational in the product, so a
backlog never blocks Voice, SMS, Web Chat, appointments, or the Inbox.

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

- [ ] Migrations applied
- [ ] `GET /health/live` returns 200 on every replica
- [ ] `GET /health/ready` returns 200 on every replica
- [ ] Web `GET /api/health` returns 200
- [ ] `pnpm ops:status` exits 0
- [ ] No capability reports `partial`
- [ ] Release identifier matches the intended commit
- [ ] Expected worker components are visible and reporting recent successes
- [ ] No unexpected growth in the oldest due item of any queue

Queues do not have to be empty to proceed.
