# Phase 22A — Locked Appointment State Machine, Concurrency & Idempotency Contract

Status: LOCKED

This document is an authoritative companion to the Avenlyo V1 Product Blueprint, Action Confirmation Contract, and Customer Identity & Disambiguation Contract. It defines the V1 correctness boundary for appointment availability, candidate slots, action intents, provider mutations, appointment lifecycle state, concurrency, idempotency, and reconciliation.

Implementation work must not weaken these rules implicitly.

Runtime deployment, production infrastructure, production credentials, provider provisioning, and production data are out of scope.

## Core separation

Avenlyo treats five concepts as separate objects:

| Object | Purpose | Durability |
| --- | --- | --- |
| Availability Query | Observe availability for a requested scope | Ephemeral |
| Candidate Slot | Time-bounded provider/application-derived offer | Short-lived |
| Action Intent | Immutable snapshot of the mutation the customer may confirm | Durable |
| Provider Operation | Durable execution record for an external mutation | Durable |
| Appointment | Persistent verified business record | Durable |

The locked separation is:

> Candidate != Appointment

and

> Action Intent != Provider Operation

Availability is an observation, not a reservation unless the authoritative provider explicitly supplies a real hold primitive and a later contract enables it.

## Candidate-slot contract

A Candidate Slot represents a trusted scheduling result that may be offered to the customer.

Minimum trusted fields include:

```text
candidate_id
appointment_type
location
resource
starts_at
ends_at
timezone
expires_at
provider_context
```

The language model must not invent these trusted values. Scheduling/application/provider layers create them and expose an opaque candidate identity to the model.

Candidate states are:

```text
ACTIVE
  ├──> CONSUMED
  ├──> EXPIRED
  └──> INVALIDATED
```

An expired candidate can never be committed.

If the customer confirms after expiry, Avenlyo must obtain fresh authoritative availability before creating or confirming a replacement mutation.

## Candidate is not a promise or hold

Unless the provider exposes an actual hold that Avenlyo has explicitly integrated, multiple customers may observe the same apparently available slot.

This is acceptable.

The final authoritative arbitration occurs at the mutation boundary.

Example:

```text
Customer A sees 14:00
Customer B sees 14:00

A confirms ─┐
            ├── authoritative scheduler/provider arbitration
B confirms ─┘
                  ↓
             one succeeds
```

The losing mutation returns an unavailable/conflict result and must obtain new alternatives.

Avenlyo must never infer that a previously observed candidate guarantees booking success.

## Immutable Action Intent

Every consequential appointment mutation is represented by an immutable Action Intent prepared before customer confirmation.

A booking intent should bind, at minimum:

```text
booking_intent_id
customer_id
subject
appointment_type
location
resource
starts_at
ends_at
timezone
candidate_id
candidate_version
created_at
expires_at
status
```

The customer confirms the exact prepared snapshot.

If any material field changes after preparation — for example 14:00 becomes 15:00 — the old intent must be invalidated and a new intent prepared.

The same intent identity may not be silently repurposed for a different action.

## Booking Intent state machine

Locked V1 booking states are:

```text
AWAITING_CONFIRMATION
       │
       ├──> EXPIRED
       ├──> INVALIDATED
       │
       ↓ valid explicit confirmation
     CLAIMED
       ↓
    COMMITTING
       │
       ├──> SUCCEEDED
       ├──> UNAVAILABLE
       ├──> DEFINITELY_FAILED
       └──> OUTCOME_UNKNOWN
```

Terminal states must not be revived by replayed customer messages or worker retries.

`CLAIMED` exists to ensure only one executor wins the right to perform the mutation.

## Atomic claim requirement

Intent execution must use an atomic compare-and-set or equivalent transactional claim.

The logical contract is equivalent to:

```text
UPDATE booking_intent
SET status = 'COMMITTING'
WHERE
  id = ?
  AND status = 'AWAITING_CONFIRMATION'
  AND expires_at > now()
```

A successful single-row claim grants execution rights.

A zero-row result means the intent is expired, invalidated, already consumed, already claimed, or otherwise not executable.

The exact schema or SQL may differ, but the atomic-claim semantics are mandatory.

Two workers processing the same confirmation must never both obtain permission to call the provider.

## Provider Operation ledger

Every external appointment mutation must have a durable Provider Operation record distinct from the Action Intent.

Minimum conceptual fields include:

```text
operation_id
intent_id
operation_type
provider
idempotency_key
provider_correlation_id
status
attempt_count
created_at
updated_at
```

Provider Operation states are:

```text
PENDING
   ↓
IN_FLIGHT
   ├──> SUCCEEDED
   ├──> DEFINITELY_FAILED
   └──> UNKNOWN
             ↓
        RECONCILING
          ├──> SUCCEEDED
          ├──> DEFINITELY_FAILED
          └──> HUMAN_REQUIRED
```

This durable record is the authoritative application answer to: “Did we already send this logical external mutation?”

## Stable idempotency identity

Each immutable logical mutation receives one stable operation identity/idempotency key.

The same logical action must reuse that identity across:

- double-clicks;
- duplicate inbound messages;
- voice/SMS/web event replay;
- worker restart;
- transient application retry;
- model/tool replay;
- network retry where retry is proven safe.

A retry must not silently generate a new mutation identity.

If the provider supports native idempotency, Avenlyo passes the stable key through according to the provider contract.

If the provider does not support native idempotency, Avenlyo's durable operation ledger remains the mandatory execution guard.

## Effective exactly-once boundary

Avenlyo does not claim universal distributed exactly-once execution across arbitrary third-party providers.

The V1 product contract is:

> Avenlyo never blindly sends a second external mutation while the first mutation's outcome is unknown.

The application therefore provides effective exactly-once behavior where the provider contract permits it, and fail-closed reconciliation where the provider result cannot be determined immediately.

## Provider timeout and unknown outcome

A timeout after sending a provider mutation does not prove failure.

Example:

```text
Avenlyo -> provider create appointment
                    ↓
             provider creates it
                    ↓
             response is lost
                    X
                timeout
```

The appointment may exist or may not exist.

Therefore Avenlyo must not tell the customer that the appointment definitely failed or definitely succeeded until trusted state is established.

The required state is:

`OUTCOME_UNKNOWN`

Customer-facing behavior must communicate that the result is being verified and that Avenlyo will not resend the mutation blindly because doing so could create a duplicate.

## No blind retry from UNKNOWN

Once an operation is `UNKNOWN` or the intent is `OUTCOME_UNKNOWN`, a new provider create/change mutation for the same logical operation is forbidden until reconciliation establishes a safe next action.

Incorrect:

```text
timeout
  ↓
retry create
  ↓
duplicate appointment
```

Required:

```text
timeout
  ↓
OUTCOME_UNKNOWN
  ↓
same logical operation blocked
  ↓
provider reconciliation
```

Reconciliation may use trusted provider correlation identifiers, idempotency keys, exact appointment timing, customer identity, resource identity, and bounded creation windows where the provider supports them.

Possible reconciliation outcomes are:

```text
UNKNOWN -> SUCCEEDED
UNKNOWN -> DEFINITELY_FAILED
UNKNOWN -> HUMAN_REQUIRED
```

`DEFINITELY_FAILED` may be reached only when the authoritative provider contract or a trusted reconciliation path proves non-execution sufficiently to permit a safe subsequent action.

## Provider success with local persistence failure

An external provider may succeed while local persistence fails.

Example:

```text
provider create -> SUCCESS
        ↓
local appointment persistence -> failure
```

Avenlyo must not solve this by issuing a second provider create.

Provider success/correlation information must be associated with the durable operation record whenever possible. Reconciliation then repairs or reconstructs the local appointment representation from provider truth.

The recovery rule is:

```text
provider truth
      ↓
reconciliation
      ↓
local state repair
```

not:

```text
local write failed
      ↓
second provider create
```

## Local success must not imply provider success

A local pending row or intent record must not be exposed as a confirmed appointment merely because local persistence succeeded.

`CONFIRMED` business truth requires trusted confirmation of the underlying scheduling result according to the provider/application contract.

Application execution state and business appointment state are separate concepts.

## Appointment lifecycle state is distinct from operation state

Appointment business lifecycle states may include:

```text
CONFIRMED
CANCELLED
COMPLETED
NO_SHOW
```

Execution states such as:

```text
CANCELLING
RESCHEDULING
PROVIDER_TIMEOUT
OUTCOME_UNKNOWN
```

belong to Action Intent / Provider Operation state rather than being overloaded into the durable business lifecycle value.

This separation prevents an in-flight or uncertain mutation from overwriting the last verified appointment truth.

## Reschedule is a version-bound Change Intent

A reschedule must bind to the exact appointment revision it was prepared against.

Conceptually:

```text
appointment_id
expected_version
old_start
new_start
operation = RESCHEDULE
```

If the appointment changes before commit, the prepared intent is stale.

Example:

```text
intent expected_version = 7
current appointment_version = 8
```

The commit must fail closed as stale, refresh authoritative state, and require a newly prepared/confirmed mutation where appropriate.

A stale customer confirmation must never silently mutate a newer appointment revision.

## Optimistic concurrency control

Appointments require a durable revision/version or equivalent concurrency token.

Every authoritative appointment mutation advances that revision.

Change intents bind to the revision used during preparation.

This protects against races such as:

```text
AI prepares cancellation at version 7
Receptionist reschedules appointment -> version 8
Customer confirms old cancellation
```

The old cancellation is stale and cannot execute against version 8.

## Concurrent changes to one appointment

Multiple prepared intents may exist, but only one mutation may hold the execution claim for a given appointment/revision at a time.

Example:

```text
SMS requests cancellation
Voice requests reschedule
```

Atomic arbitration determines the committing mutation.

After one succeeds and advances the appointment revision, other prepared intents against the old revision become stale.

## Reschedule must not be unsafe cancel-plus-book emulation

Avenlyo must not represent an unsafe sequence of “cancel old appointment, then create new appointment” as if it were an atomic reschedule.

The failure mode is unacceptable:

```text
cancel succeeds
new booking fails
```

If the provider exposes a safe native reschedule capability or a later explicitly designed transactional/saga contract, Avenlyo may use it.

If not, automated reschedule capability must be disabled for that provider and the workflow must hand off to a human rather than risking loss of the existing appointment.

## Cancellation idempotency

Cancellation is logically idempotent for the exact appointment/revision target.

If the appointment is already authoritatively cancelled, replay of the same logical cancellation must not issue a duplicate external mutation.

The application may return an already-cancelled/cancelled result consistent with the verified terminal business state.

A different appointment or materially different revision still requires its own valid intent.

## Confirmation must bind to trusted inbound identity where available

Where channel infrastructure provides a trusted inbound message/event identity, the confirmed operation should bind both:

```text
action_intent_id
triggering_inbound_message_id
```

or equivalent trusted replay key.

Reprocessing the same inbound event and same intent must return the same logical execution/result and must not create a second provider mutation.

## Corrections invalidate old intents

If the customer changes a material value before commit, the old intent becomes `INVALIDATED`.

Example:

```text
AI: “Book Friday 14:00?”
Customer: “Make it 15:00.”
```

The 14:00 intent is invalidated. Avenlyo obtains/prepares a 15:00 candidate and new intent.

A delayed or out-of-order “yes” must not revive the invalidated 14:00 mutation.

## Timezone contract

Appointment timing must use:

- a canonical absolute instant; and
- an authoritative IANA timezone.

Example:

```text
2026-09-04T11:00:00Z
Europe/Istanbul
```

Customer-facing rendering may display the appropriate local time.

At commit time, the model must not re-parse conversational text such as “Friday at 2” to generate a fresh execution timestamp.

The commit uses the exact trusted instant stored in the prepared intent.

DST-sensitive regions must also use exact instants produced by trusted scheduling logic rather than model inference.

## Provider event and webhook idempotency

Provider events may be duplicated, retried, or arrive out of order.

Integration layers should deduplicate with a trusted provider event identity such as:

```text
provider_event_id
```

A repeated event must not apply the same business transition twice.

An older event must not regress a newer authoritative appointment revision merely because it arrived later.

## Reminder/follow-up coupling

Appointment lifecycle automation must follow verified appointment truth.

For example:

```text
CONFIRMED
  ↓
schedule applicable reminders
```

After a verified reschedule:

```text
old reminders invalidated
new reminders scheduled
```

After verified cancellation:

```text
future reminders cancelled or skipped
```

An unknown mutation outcome must not prematurely move reminders to an unverified new appointment state.

## Required acceptance scenarios

The implementation and staging acceptance suite must cover at least these race/failure cases:

| Scenario | Required result |
| --- | --- |
| Two customers select the same slot | One succeeds; the other receives unavailable/conflict |
| Same customer confirms twice | One logical provider mutation |
| Two workers process the same confirmation | One atomic claimant |
| Candidate expires before confirmation | Fresh availability required |
| Authorized staff changes appointment while intent is pending | Version mismatch; stale intent cannot commit |
| Provider request times out after send | `OUTCOME_UNKNOWN`; no blind retry |
| Customer correction is followed by delayed old confirmation | Old intent remains invalid |
| Provider sends same webhook twice | Event deduplicated |
| Provider succeeds but local persistence fails | Reconciliation repairs local state; no second provider create |

These are product correctness tests, not optional implementation details.

## Interaction with Customer Identity & Disambiguation

Appointment mutation never begins from conversation plausibility alone.

The minimum chain remains:

```text
trusted identity / channel context
  ↓
authorized customer scope
  ↓
exact subject and appointment target where applicable
  ↓
trusted candidate / current appointment revision
  ↓
immutable Action Intent
  ↓
explicit valid confirmation
  ↓
atomic claim
  ↓
idempotent Provider Operation
  ↓
trusted provider result or reconciliation
  ↓
verified Appointment truth
```

Identity, confirmation, concurrency, and provider-result verification are independent gates. Success at one gate cannot compensate for failure at another.

## Locked V1 invariants

1. Availability is an observation, not a guaranteed reservation.
2. Candidate Slot, Action Intent, Provider Operation, and Appointment are distinct product objects.
3. Expired or invalidated candidates/intents cannot be revived or committed.
4. Material correction creates a new intent; old intent identity cannot be repurposed.
5. Every mutation requires atomic execution claim semantics.
6. The same logical intent must not produce a second external mutation because of replay, duplicate confirmation, worker restart, or retry.
7. Stable idempotency identity is reused for the same logical operation.
8. Provider timeout after send becomes an unknown outcome unless authoritative evidence proves otherwise.
9. UNKNOWN outcomes are never blindly retried.
10. Provider success with local persistence failure is repaired by reconciliation, not by duplicate provider creation.
11. Local persistence alone does not establish confirmed provider/business truth.
12. Appointment lifecycle state and mutation execution state remain separate.
13. Change intents bind to an exact appointment revision/version.
14. A stale intent cannot mutate a newer appointment revision.
15. Only one mutation may hold the committing claim for one appointment/revision at a time.
16. Unsafe cancel-plus-book must not be presented as atomic reschedule.
17. Cancellation replay for the exact already-cancelled target is idempotent.
18. Trusted inbound event/message identities should participate in replay protection where available.
19. Exact trusted instants and IANA timezones are used at commit; the model does not reconstruct execution time from prose.
20. Provider webhook/event duplication and out-of-order delivery must not duplicate or regress business state.
21. Reminders/follow-ups move only from verified appointment truth.
22. Stale state never authorizes a mutation.
23. Unknown state is never guessed into success or failure.
24. Provider truth is never overwritten without a trusted reconciliation path.

## Canonical summary

The locked V1 scheduling contract is:

> Availability is observation; Candidate Slot is a time-bounded offer; Action Intent freezes exactly what the customer may approve; Provider Operation is the durable idempotent external-mutation boundary; Appointment is verified persistent business truth.

Four safety principles summarize the contract:

> No mutation from stale state.
>
> No second external mutation for the same logical intent.
>
> Never guess an unknown provider outcome into success or failure.
>
> Never overwrite provider/business truth without trusted reconciliation.
