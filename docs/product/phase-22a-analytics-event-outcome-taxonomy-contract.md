# Phase 22A — Locked Analytics Event & Outcome Taxonomy Contract

Status: LOCKED

This document is an authoritative companion to the Avenlyo V1 Product Blueprint and the other locked Phase 22A contracts. It defines how customer work, business outcomes, operational control, and system reliability are measured without allowing model self-evaluation, client telemetry, or vanity metrics to become product truth.

Implementation work must not weaken these rules implicitly.

Runtime deployment, production infrastructure, provider provisioning, production credentials, and production data are out of scope.

## Core analytics principle

Avenlyo measures completed customer work, not message volume.

The primary product rule is:

> Model output is never authoritative evidence that a customer intent succeeded.

Resolution is derived from trusted application state, durable business transitions, provider-confirmed outcomes, persisted/delivered customer responses where applicable, and explicit human-resolution evidence.

## Primary analytics unit — Customer Intent Episode

The primary unit of customer-work analytics is a `Customer Intent Episode`, not a conversation and not a message.

One conversation may contain multiple distinct customer intents. One intent may require many customer/assistant turns, clarification questions, slot selections, confirmation, tool calls, and provider operations.

Clarification within one customer goal does not create a new intent episode.

Example:

```text
Customer: I need an appointment.
AI: Which day works?
Customer: Friday.
AI: 10:30 or 14:00?
Customer: 14:00.
```

This is one `APPOINTMENT_BOOK` intent episode.

A genuinely new customer goal creates a new episode, even within the same conversation.

## Intent Episode lifecycle

The conceptual lifecycle is:

```text
OPEN
  ├──→ WAITING_CUSTOMER
  ├──→ WAITING_SYSTEM
  ├──→ WAITING_HUMAN
  ├──→ OUTCOME_UNKNOWN
  ├──→ RESOLVED
  └──→ FAILED
```

`OUTCOME_UNKNOWN` is not success and is not definite failure.

It may transition only after trusted reconciliation:

```text
OUTCOME_UNKNOWN
      ├──→ RESOLVED
      └──→ FAILED
```

A resolved episode may later become `REOPENED` when new evidence shows the customer’s task was not actually complete or the customer explicitly reopens the same work.

`REOPENED` must not silently create a second success count for the same logical resolution cycle.

## Multi-intent conversations

A single customer message may create multiple intent episodes when it contains distinct goals.

Example:

```text
“Move my appointment to Thursday and how much is the service?”
```

may open:

```text
APPOINTMENT_RESCHEDULE
BUSINESS_INFORMATION
```

The locked Intent and Confirmation contracts still apply: multiple intents do not grant permission to run multiple consequential mutations under one ambiguous confirmation.

## North-star metric

The locked V1 north-star metric is:

# Successfully Resolved Customer Intents

Definition:

> The count of eligible Customer Intent Episodes that reached `RESOLVED` with trusted resolution evidence.

Conceptually:

```text
Successfully Resolved Customer Intents
=
count(
  eligible intent episodes
  where state = RESOLVED
  and trusted resolution evidence exists
)
```

A model sentence, a tool invocation, a handoff resolution, or a lead row alone is not sufficient evidence.

## North-star eligibility

The intended V1 eligibility model is:

| Intent class | North-star eligible? |
| --- | ---: |
| `BUSINESS_INFORMATION` | Yes |
| `APPOINTMENT_BOOK` | Yes |
| `APPOINTMENT_LOOKUP` | Yes |
| `APPOINTMENT_RESCHEDULE` | Yes |
| `APPOINTMENT_CANCEL` | Yes |
| `SERVICE_INTEREST` | Conditional on the actual customer goal |
| `COMPLAINT_OR_EXCEPTION` | Yes when genuinely resolved |
| `HUMAN_REQUEST` | No — routing/operational metric |
| `SAFETY_ESCALATION` | No — safety metric |
| `GENERAL_CONVERSATION` | No |
| `OUT_OF_SCOPE` | No |

Safety and human-routing actions may be correct product behavior without being AI resolution.

## Handoff is not customer resolution

Creating a human handoff is not equivalent to solving the customer’s task.

A correctly triggered safety handoff is a safety success but does not count as `AI_RESOLVED_INTENT`.

Likewise:

```text
handoff.status = RESOLVED
```

does not imply:

```text
intent.status = RESOLVED
```

The Handoff Contract and Intent outcome remain separate state machines.

Human resolution requires its own trusted evidence.

## Resolution evidence matrix

The preferred V1 evidence rules are:

| Intent | Trusted evidence required for `RESOLVED` |
| --- | --- |
| Business information | Authoritative config or reliable knowledge plus a customer-facing answer that reached the applicable channel boundary |
| Availability question | Trusted scheduler result plus customer-facing answer |
| New booking | Provider-confirmed success plus durable appointment state |
| Appointment lookup | Authorized trusted lookup plus customer-facing response |
| Reschedule | Provider-confirmed change plus durable local state |
| Cancellation | Provider-confirmed cancellation plus durable local state |
| Service information | Grounded answer or explicit trusted next step appropriate to the customer’s goal |
| Human/callback request | Separate routing outcome; not ordinary AI resolution |
| Lead capture | Business outcome only; not sufficient customer-resolution evidence |
| Safety escalation | Safety outcome; not ordinary customer resolution |
| Provider `unknown` | Never resolved until reconciliation provides evidence |

## Tool success is not customer success

A tool execution status describes the execution of that capability, not completion of the customer’s goal.

Examples:

```text
get_available_appointments = succeeded
```

may still result in the customer rejecting every slot.

```text
search_business_knowledge = succeeded
```

may still return no reliable evidence.

Therefore `tool.status = succeeded` must not directly increment the north-star metric.

## Lead capture is a business outcome, not customer resolution

Lead capture is valuable but must not inflate customer-resolution analytics.

A customer may ask for a price, fail to receive a reliable answer, and still create a durable lead. The lead is a business outcome, while the customer intent remains unresolved.

The lead funnel is measured separately:

```text
SERVICE INTEREST
      ↓
LEAD CAPTURED
      ↓
QUALIFIED
      ↓
APPOINTMENT BOOKED
      ↓
CONVERTED
```

Representative lead metrics include:

- lead capture rate;
- lead qualification rate;
- lead-to-appointment conversion;
- median time to conversion.

## Booking conversion and booking reliability are separate

`Booking Conversion Rate` measures product/customer conversion:

```text
provider-confirmed bookings
───────────────────────────
APPOINTMENT_BOOK intent episodes
```

`Booking Success Rate` measures technical commit reliability:

```text
successful provider booking operations
──────────────────────────────────────
confirmed booking commit attempts
```

A customer finding no acceptable slot may reduce conversion without indicating a provider reliability failure.

## Provider outcome taxonomy

Consequential provider-operation analytics must preserve the semantic distinction among outcomes such as:

```text
SUCCEEDED
UNAVAILABLE
DEFINITELY_FAILED
OUTCOME_UNKNOWN
RECONCILED_SUCCEEDED
RECONCILED_FAILED
HUMAN_REQUIRED
```

`OUTCOME_UNKNOWN` must never be silently grouped into ordinary failure.

A separate `Unknown Outcome Rate` is required because it represents a materially different risk: the external mutation may already have happened.

## AI Resolution Rate

`AI Resolution Rate` is a secondary metric, not a replacement for the north star.

Definition:

```text
eligible intents resolved without human intervention
────────────────────────────────────────────────────
all eligible customer intents
```

The metric must not count mixed or human-completed outcomes as AI-only success.

## Resolution actor

Terminal resolved intent episodes should support a bounded actor classification:

```text
AI
HUMAN
MIXED
SYSTEM
```

Meaning:

- `AI`: the customer task was completed by the agent plus trusted tools without human intervention;
- `HUMAN`: a human operator performed the material resolution;
- `MIXED`: the AI materially prepared or advanced the task, but a human completed it;
- `SYSTEM`: deterministic non-LLM automation completed the customer-facing outcome.

This classification must be derived from trusted workflow state, not model self-report.

## Handoff rate

`Handoff Rate` measures customer-work episodes entering human attention.

It must support reason breakdowns such as:

```text
customer_requested_human
safety_escalation
provider_outcome_unknown
provider_capability_unsupported
identity_ambiguous
appointment_target_ambiguous
automation_failure
other
```

A single aggregate handoff percentage is insufficient for product diagnosis.

## Knowledge Gap Rate

`Knowledge Gap Rate` measures business-specific information needs for which no reliable business evidence was available.

Conceptually:

```text
business-information turns with no reliable evidence
────────────────────────────────────────────────────
turns requiring business-specific knowledge
```

The metric is derived from trusted knowledge-reliability diagnostics and customer-work context, not from the model claiming uncertainty.

The product may later use this signal to surface actionable knowledge gaps to the business, but the analytics contract does not authorize automatic publication or invention of missing facts.

## Failed Action Rate

For consequential external mutations, `Failed Action Rate` measures definite failures only.

Conceptually:

```text
definitely failed external mutations
────────────────────────────────────
external mutation attempts
```

`OUTCOME_UNKNOWN` is reported separately and must not be hidden inside this denominator or numerator.

## Reopen Rate

A resolved customer intent may be reopened when the same work is shown to be incomplete, incorrect, or explicitly reopened by the customer.

`Intent Reopen Rate` is a quality metric for premature or incorrect resolution.

The product must not create a new unrelated intent solely to avoid showing that a prior resolution reopened.

## Information-answer resolution

For information intents, the preferred V1 evidence is:

```text
trusted factual evidence
+
customer-facing response reached the applicable channel boundary
        ↓
RESOLVED
```

This means the product measures that the requested information was reliably answered. It does not claim customer satisfaction.

Customer satisfaction, if introduced later, is a separate metric.

## Message delivery as outcome evidence

A generated response is not always a delivered response.

Channel-specific delivery/persistence truth may therefore be part of resolution evidence.

For example, an SMS response that is definitively `undelivered` cannot be treated exactly like a delivered answer.

The product must preserve provider delivery truth, including `unknown`, rather than overwriting it with model or UI assumptions.

## Analytics event payloads are bounded and privacy-minimized

Analytics events must not become a second transcript or PII warehouse.

A conceptual event may contain bounded fields such as:

```text
event_id
event_name
occurred_at
organization_id
location_id
conversation_id
intent_episode_id
industry_id
channel
source_entity_type
source_entity_id
source_version
outcome_class
reason_code
schema_version
```

Only product-approved low-cardinality metadata may be added.

Analytics events must not copy customer message bodies, phone numbers, email addresses, medical histories, VINs, or other sensitive/free-text payloads merely for convenience.

## Analytics is not business-state authority

Domain state remains authoritative in business objects such as:

- appointments and provider operations;
- leads;
- conversations and messages;
- handoffs;
- customers;
- integrations.

Analytics records are measurements of authoritative transitions.

The locked direction is:

```text
authoritative domain transition
        ↓
analytics fact/event
```

and never:

```text
analytics event says “booked”
        ↓
therefore the appointment is booked
```

Analytics may not drive business state backward.

## Server-derived and durable events

Critical business metrics must not depend on untrusted browser telemetry.

For example, a client click on `Confirm` is not `appointment.booking_succeeded`.

The event may be recorded only after the authoritative sequence reaches the required business state:

```text
customer confirms
       ↓
server validates
       ↓
provider operation
       ↓
provider-confirmed success
       ↓
durable appointment state
       ↓
booking-success analytics fact
```

Transactional outbox or equivalent durable post-commit semantics are preferred for critical transitions during implementation.

## Event idempotency

Provider webhook replay, server retry, duplicate inbound transport events, and repeated browser submissions must not double-count one logical business transition.

The implementation must support a stable semantic identity for analytics facts, for example based on event type plus authoritative entity/version/operation identity.

The locked invariant is:

> One logical business transition produces one logical analytics event.

## Event families

V1 analytics is organized into four semantic families.

### Customer Work

Examples:

```text
intent.opened
intent.waiting_customer
intent.waiting_system
intent.waiting_human
intent.resolved
intent.reopened
intent.failed
```

A resolved intent should carry bounded resolution metadata such as actor class, resolution class, and authoritative evidence reference/type.

### Business Outcome

Examples:

```text
appointment.booking_succeeded
appointment.booking_unavailable
appointment.reschedule_succeeded
appointment.cancellation_succeeded
lead.captured
lead.qualified
lead.converted
reminder.sent
reminder.failed
```

### Operational Control

Examples:

```text
handoff.created
handoff.escalated
handoff.claimed
handoff.released
handoff.resolved
conversation.human_takeover
conversation.ai_resumed
```

These events describe workflow control, not customer-resolution success.

### System Reliability

Examples:

```text
agent.turn_provider_failed
agent.loop_limit_reached
tool.execution_failed
provider.operation_unknown
provider.operation_reconciled
message.delivery_failed
message.delivery_unknown
knowledge.no_reliable_source
```

Raw provider exception strings must not become high-cardinality analytics dimensions or customer-facing diagnostics.

## Cost and efficiency metrics

Token usage, model latency, tool-call count, and monetary cost are operational optimization metrics.

Useful internal metrics may include:

- tokens per resolved intent;
- AI cost per resolved intent;
- tool calls per resolved intent;
- model latency per resolved intent.

They are not product-success metrics and must not be optimized at the expense of correctness, safety, or trusted task completion.

## Business-facing Overview metrics

The business-facing dashboard should remain bounded and operationally meaningful.

Representative first-line metrics are:

- AI-resolved today;
- appointments booked;
- new leads;
- needs attention;
- customer intents handled.

A deeper analytics surface may add:

- AI resolution rate;
- booking conversion;
- lead conversion;
- handoff rate;
- first response time;
- knowledge gap rate.

Reliability-heavy diagnostics such as unknown-provider outcomes and failed external actions may be shown in a dedicated owner/admin health area rather than crowding the primary business overview.

## Counts and rates must be shown together

Rates without workload counts are misleading.

Where useful, the product should present both values, for example:

```text
AI resolved 184 of 221 eligible customer intents — 83.3%
9 currently pending
```

Pending customer work must not be hidden merely to improve the displayed rate.

## Test mode isolation

Agent Test data must never affect production/customer analytics.

Test conversations and runs may have their own diagnostics, but they must not increment:

- production customer-intent counts;
- booking conversion;
- lead conversion;
- handoff rate;
- AI resolution rate;
- business-facing customer outcome metrics.

The runtime mode distinction must be preserved end-to-end in analytics derivation.

## Version dimensions

Internal analytics may retain bounded implementation dimensions such as:

```text
model
agent_contract_version
industry_pack_version
```

These are useful for release comparison and product-quality analysis.

They are not required as business-facing dimensions.

## Reconstructability

Critical metrics should be reconstructable as far as practical from durable domain state and bounded transition records.

A lost client event must not make an authoritative booking count impossible to recover.

Client analytics may supplement UX analysis, but customer/business outcome truth remains server/domain-derived.

## V1 metric set

The V1 metric definitions that must be testable before Product Acceptance are:

| Metric | Primary authority |
| --- | --- |
| Successfully Resolved Customer Intents | Intent outcome plus trusted evidence |
| AI Resolution Rate | Intent outcome plus human-attention/actor state |
| Booking Conversion Rate | Book intent → provider-confirmed appointment |
| Booking Success Rate | Confirmed commit → provider-confirmed success |
| Handoff Rate | Intent → human attention |
| Knowledge Gap Rate | Required business knowledge → no reliable evidence |
| Failed Action Rate | Definitive external mutation failure |
| Unknown Outcome Rate | Provider operation `OUTCOME_UNKNOWN` |
| Lead Capture Rate | Service interest → durable lead |
| Lead Conversion Rate | Lead → durable converted appointment |
| Intent Reopen Rate | Resolved → reopened |
| Human Waiting Time | Human-attention/waiting read model |
| First Response Time | Trusted inbound → applicable customer-facing response boundary |

## Optimization hierarchy

Avenlyo should optimize in this order:

```text
Can Avenlyo resolve customer work correctly?
        ↓
Can it do so autonomously where appropriate?
        ↓
Can it do so reliably?
        ↓
Does this produce bookings/leads/business value?
        ↓
How efficiently does it do it?
```

The metric system must not reward unsafe or low-quality behavior merely because it increases message volume, lead capture, booking attempts, or suppresses appropriate handoffs.

## Locked invariants

The following are authoritative for Avenlyo V1:

1. Customer Intent Episode is the primary unit of product-resolution analytics.
2. The north-star metric is `Successfully Resolved Customer Intents`.
3. Resolution requires trusted evidence; the model cannot declare its own success.
4. Tool execution success is not customer-resolution success.
5. Handoff creation or handoff resolution is not automatically customer-intent resolution.
6. Safety routing and explicit human requests are measured separately from ordinary AI resolution.
7. Lead creation is a business outcome, not sufficient customer-resolution evidence.
8. Booking conversion and booking-operation reliability remain separate metrics.
9. `OUTCOME_UNKNOWN` remains distinct from success and definite failure until reconciliation.
10. Resolved intents may become `REOPENED` when evidence/customer behavior warrants it.
11. Production business metrics are derived from server/domain truth, not client clicks.
12. One logical business transition is counted once despite retries/replays.
13. Analytics events are bounded and privacy-minimized; they are not a transcript/PII copy.
14. Analytics events never become business-state authority.
15. Test-mode activity never affects production/customer metrics.
16. Cost/token efficiency is subordinate to correctness, safety, and trusted completion.
17. Critical V1 metrics must have deterministic, testable definitions before Product Acceptance.

Any future product metric that materially changes these semantics requires explicit product review rather than silent instrumentation drift.
