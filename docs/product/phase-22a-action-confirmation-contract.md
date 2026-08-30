# Phase 22A — Locked Action Confirmation Contract

Status: LOCKED

This document is an authoritative companion to the Avenlyo V1 Product Blueprint. It defines the V1 confirmation boundary for agent actions. Implementation work must not weaken these rules implicitly.

Runtime, staging, deployment, production credentials, production infrastructure, and production data are out of scope.

## Core policy

Avenlyo uses bounded autonomy with four action classes:

1. **Observe** — read trusted facts without changing customer or provider state.
2. **Prepare** — create or select an intent/candidate without performing the final external mutation.
3. **Commit** — perform a durable or external mutation after all required gates pass.
4. **Escalate** — create a human work item when AI should not continue autonomously.

The default confirmation rule is:

- Observe: no customer confirmation.
- Prepare: no customer confirmation because the final external mutation has not happened.
- Low-risk internal operational record: no separate confirmation when it records only facts the customer explicitly provided and does not create outbound-contact permission.
- External customer-state mutation: explicit confirmation bound to one exact pending action.
- Destructive mutation: explicit confirmation plus exact unambiguous target.
- Safety/human escalation: no confirmation required.
- Unsupported, financial, clinical, safety-judgment, or otherwise prohibited action: AI may not commit it.
- Unknown provider outcome: fail closed; do not blindly retry and do not claim success or failure without evidence.

## V1 action matrix

| Action | Class | Customer confirmation | AI may execute? | Locked rule |
| --- | --- | --- | --- | --- |
| Search published business knowledge | Observe | No | Yes | Answer only from sufficiently reliable trusted sources. |
| Read authoritative business configuration | Observe | No | Yes | Configuration remains authoritative for fields it owns. |
| Query appointment availability | Observe | No | Yes | Availability is never represented as a booking. |
| Retrieve upcoming appointments | Observe | No | Yes | Identity/authorization must already be sufficient. |
| Capture/update a lead | Low-risk internal durable record | No separate confirmation | Yes | Record only explicitly observed customer facts; never infer missing fields. Lead capture does not grant marketing/outbound-contact consent. |
| Create human handoff | Escalate | No | Yes | Human request or safety policy may trigger immediately. |
| Prepare appointment booking | Prepare | No | Yes | Does not create an appointment. |
| Book appointment | Commit | Yes | Only after valid confirmation | Confirmation must bind to one exact prepared booking. |
| Prepare appointment reschedule | Prepare | No | Yes | Does not alter the existing appointment. |
| Reschedule appointment | Commit | Yes | Only after valid confirmation | Customer must be shown the exact old and new appointment state before commit. |
| Prepare appointment cancellation | Prepare | No | Yes | Does not cancel the appointment. |
| Cancel appointment | Destructive commit | Yes | Only after valid confirmation | Exact appointment target must be unambiguous before confirmation. |
| Configured appointment reminder | Policy-driven automated commit | No per-message confirmation | Only under configured business policy | Requires enabled reminder policy and a valid messaging capability; this does not authorize unrelated outbound messaging. |
| Ad-hoc outbound follow-up/SMS | Consequential outbound action | Not authorized in V1 agent policy | No | Requires a future explicit outbound-messaging policy. |
| Arbitrary customer identity/profile mutation | Durable identity mutation | Not authorized in V1 agent policy | No | Governed by the separate identity/disambiguation contract and business-side controls. |
| Payment, charge, refund, financial commitment | Financial | Not authorized | No | Human/business-controlled in V1. |
| Clinical diagnosis/treatment/contraindication decision or vehicle safety assurance | Prohibited judgment | Not applicable | No | Follow industry safety/escalation policy. |

## Booking confirmation

A new appointment must not be committed merely because the customer's first message sounds imperative, for example “Book me Friday at 14:00.”

Locked V1 flow:

```text
request
  ↓
trusted availability
  ↓
customer selects a candidate
  ↓
prepare booking intent
  ↓
show human-readable exact summary
  ↓
explicit customer confirmation
  ↓
commit
  ↓
trusted success verification
  ↓
represent appointment as confirmed
```

A confirmation prompt must identify the meaningful customer-facing details required to understand the mutation, such as appointment type, location when relevant, date/time, and subject where relevant. Internal identifiers must not be exposed.

## Confirmation binds to one exact pending action

A response such as “yes”, “okay”, “confirm”, or equivalent has authorization meaning only when all of the following are true:

- exactly one mutating action is pending;
- the previous agent message clearly summarized that action;
- the customer response unambiguously approves it;
- the prepared intent/candidate is still current;
- all policy, identity, capability, target, and provider gates still pass.

A confirmation cannot authorize a different action, a changed action, or multiple mutations.

## Corrections invalidate confirmation state

A customer correction is not a confirmation.

Example:

> “Yes, but make it 15:00 instead.”

The prior prepared action becomes stale. Avenlyo must re-resolve/revalidate the changed detail, prepare a new intent when applicable, present the revised exact summary, and obtain a new confirmation before commit.

## Confirmation invalidation conditions

A previously pending confirmation is invalid if any of the following occurs:

1. date or time changes;
2. appointment type changes;
3. location or resource changes;
4. customer corrects the selection;
5. candidate or intent expires;
6. revalidation does not reproduce the required state;
7. customer says no, stop, wait, or otherwise withdraws approval;
8. appointment target becomes ambiguous;
9. customer identity becomes insufficient or ambiguous;
10. human takeover begins;
11. a safety escalation interrupts the flow;
12. provider outcome becomes unknown;
13. the prepared intent has already been executed.

Confirmation is single-use.

## Cancellation rule

Confirmation does not resolve ambiguity.

If more than one appointment could match “cancel my Tuesday appointment”, Avenlyo must disambiguate the appointment before preparing cancellation. Only after one exact target is resolved may the cancellation summary and confirmation prompt be produced.

## Reschedule rule

A reschedule confirmation must show both sides of the change in human-readable form:

- current appointment state;
- proposed new appointment state.

The customer must understand that an existing appointment is being changed, not merely that a new slot is being offered.

## One pending mutation

The Locked Intent Contract rule remains authoritative: a conversation may have at most one actionable mutating intent pending confirmation at a time.

Multiple requested mutations must either be normalized into one supported atomic operation or executed as separate prepare → confirm → commit → verify cycles.

## Unknown outcome rule

When a provider call returns an outcome that cannot be reliably classified as success or failure, Avenlyo must not say either “completed” or “failed” if that claim is not supported.

Locked behavior:

```text
provider outcome unknown
  ↓
do not repeat mutation blindly
  ↓
mark OUTCOME_UNKNOWN / unresolved
  ↓
create reconciliation or human work item
  ↓
preserve customer context
```

This rule exists to prevent duplicate appointments, duplicate cancellations, or other repeated external mutations.

## Human handoff

Explicit customer requests for a person and industry safety escalations do not require an additional “do you want me to escalate?” confirmation. Creating a handoff is the safe path and does not itself prove that a human has responded.

## Lead capture

Lead creation is an operational record, not a customer intent and not marketing consent.

The agent may record a genuine service interest without an extra confirmation dialog only when it uses facts plainly stated by the customer. It must never infer identity, urgency, service details, sensitive fields, or other missing facts. Creating a lead must not silently authorize outbound campaigns or unrelated contact.

## Exit test for any future mutating action

A new action may be added to V1 autonomy only after its product policy answers all of these questions explicitly:

1. Is it Observe, Prepare, Commit, Escalate, or Prohibited?
2. What exact target is being acted on?
3. What identity level is required?
4. What capability/provider support is required?
5. Does it require confirmation?
6. What exact state is included in that confirmation?
7. What invalidates the confirmation?
8. Is the commit idempotent or otherwise duplicate-safe?
9. What does unknown outcome mean?
10. What is the human fallback?

Until those are answered, the action must remain unavailable to autonomous execution.
