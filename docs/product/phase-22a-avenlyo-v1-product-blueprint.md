# Phase 22A — Avenlyo V1 Product Blueprint

Status: IN DESIGN

This document is the product contract for Avenlyo V1. It intentionally precedes production infrastructure work. Runtime, staging, deployment, production credentials, production infrastructure, and production data are out of scope for this phase.

## Locked V1 decisions

The following decisions are product-level constraints. They are not suggestions and should not be weakened implicitly by implementation work.

1. **Avenlyo is an AI Front Office, not a chatbot.**
   - The product is judged by whether customer work is completed correctly, not by message volume.
   - The core loop is: understand → resolve from trusted facts → act through trusted tools → verify → record → escalate when needed.

2. **V1 targets appointment-driven local service businesses.**
   - Launch industry packs: Veterinary Clinic, Auto Repair, Medspa / Aesthetics.
   - The core platform should remain reusable, but launch product behavior is industry-aware rather than generic “AI for any business”.

3. **Agent autonomy is bounded.**
   - Read-only facts may be retrieved without customer confirmation.
   - Actions may be prepared before commitment.
   - A real external or durable mutation may only be claimed after the corresponding trusted tool reports success.
   - Destructive, consequential, ambiguous, or policy-sensitive actions require an explicit confirmation or human handoff according to the action contract.
   - Uncertainty must fail closed rather than be filled with model assumptions.

4. **Inbox is the operational queue.**
   - `Needs Attention` is not a separate primary business object in V1.
   - It becomes an Inbox state/filter.
   - `Conversations` remains the complete historical communication record.

5. **North-star metric: successfully resolved customer intents.**
   - Supporting metrics include AI resolution rate, booking conversion rate, booking success rate, human handoff rate, failed action rate, lead capture rate, and median first response time.

## Product definition

Avenlyo is a 24/7 AI Front Office for appointment-driven local service businesses. It communicates with customers, answers from authoritative business information, captures leads, finds real appointment availability, completes approved bookings, supports appointment lifecycle operations where the provider allows them, records what happened, and hands work to a human when it cannot safely or reliably complete the intent.

The business-side application is the control center for that work. It should answer four questions quickly:

- What happened?
- What did Avenlyo complete?
- What is still unresolved?
- What requires a human now?

## Primary actors

### Customer

The customer should experience the business, not Avenlyo’s internal architecture. They should never need to understand provider names, workspace IDs, tool calls, booking intents, internal statuses, or implementation details.

### Business operator

An owner, admin, or team member uses Avenlyo to supervise customer communication and outcomes. Their main job is not to “chat with the AI”; it is to understand operations, resolve exceptions, and configure what the AI is allowed to do.

### Avenlyo agent

The agent is a bounded operator. It may understand language and decide which approved capability to invoke, but external facts and actions remain authority-bound to business configuration, published knowledge, live tools, provider results, and explicit product policy.

## Authority model

The agent must distinguish three classes of information.

### Authoritative business configuration

Examples: business name, address, phone, timezone, configured business hours, enabled location, configured appointment types, enabled capabilities.

### Published business knowledge

Examples: services, published prices, policies, FAQs, new-client instructions, website-derived facts.

### Live tool state

Examples: current availability, existing appointment state, customer records, booking outcome, cancellation outcome, provider capability and failure state.

The agent may not substitute model memory or inference for missing business-specific facts.

## Bounded autonomy model

### Observe

Read trusted information without changing external state.

Examples: search published knowledge, inspect configured business hours, retrieve appointment availability, find upcoming appointments.

### Prepare

Create a durable or ephemeral intent that is not yet the final external mutation.

Examples: prepare an appointment booking, prepare a reschedule, prepare a cancellation.

### Commit

Perform an approved external or durable mutation after the required confirmation and preconditions are satisfied.

Examples: book the selected appointment, execute a confirmed reschedule, execute a confirmed cancellation.

### Escalate

Create an actionable human work item with enough context for a team member to continue without reconstructing the conversation from scratch.

## Conversation state model

The product-level conversation state is separate from individual model/tool calls.

```text
NEW
  ↓
AI_ACTIVE
  ↓
UNDERSTANDING_INTENT
  ↓
INFORMATION | LEAD | APPOINTMENT | SUPPORT
  ↓
ACTION_PENDING_CONFIRMATION   (only when an action requires confirmation)
  ↓
ACTION_EXECUTING
  ↓
RESOLVED
```

At any meaningful point, the conversation may transition to:

```text
NEEDS_ATTENTION
  ↓
HUMAN_ACTIVE
  ↓
RESOLVED
```

A controlled `HUMAN_ACTIVE → AI_ACTIVE` return may exist only when the human explicitly returns the conversation to automation and there is no unresolved safety/policy block.

## Inbox vs Conversations

### Inbox

Inbox is the operational queue. It contains work that currently requires attention or has an unresolved operational state.

Initial V1 filters:

- All open
- Needs attention
- Waiting on customer
- Assigned to me
- Unassigned

Candidate reasons include urgent escalation, human requested, tool/provider failure, ambiguous identity, unresolved booking, follow-up due, and business reply required.

### Conversations

Conversations is the complete communication history, including AI-resolved conversations. It is optimized for search, audit, customer history, outcome analysis, and investigation rather than queue clearing.

## Core entity boundaries

### Conversation

A communication thread/session. It records channel messages, participants, agent/human control state, and outcome.

### Customer

A persistent person identity. Multiple conversations, leads, and appointments can belong to the same customer.

### Lead

A commercial/service opportunity or expressed intent that may require follow-up. A customer may have multiple leads over time.

### Appointment

A durable scheduling object representing a provider-backed or approved internal appointment lifecycle.

These concepts must remain distinct even when a UI presents them together.

## Customer 360 timeline

The primary customer detail view should become a chronological operational history rather than a static CRM form. The timeline may contain:

- conversation started/resolved
- lead captured/qualified
- appointment proposed/booked/rescheduled/cancelled/completed/no-show
- reminder scheduled/sent/failed
- human handoff created/resolved
- business follow-up

## Scheduling state model

Availability is not a booking.

```text
Appointment type
  ↓
Location
  ↓
Resource / provider policy
  ↓
Availability query
  ↓
Candidate slot
  ↓
Candidate expiry / revalidation boundary
  ↓
Customer selection
  ↓
Booking intent
  ↓
Required confirmation
  ↓
Provider commit
  ↓
Confirmed appointment
  ↓
Reminder lifecycle
  ↓
Completed | Cancelled | No-show
```

Provider differences belong behind Avenlyo’s scheduling capability layer. The agent should reason in terms of Avenlyo capabilities such as availability, booking, rescheduling, and cancellation—not provider-specific API semantics.

## Human handoff contract

Human handoff is a first-class product feature, not an error fallback.

A handoff work item should carry at minimum:

- reason
- urgency
- customer identity if known
- concise customer goal
- relevant collected facts
- what the agent already tried
- whether any external action was actually committed
- what remains unresolved
- related appointment/lead/customer references when available

The agent must never imply that a human action has happened merely because a handoff item was created.

## Phase 22A.1 — Customer journey contract

The following journeys define the next design work. Each journey must eventually specify: entry conditions, trusted facts, required questions, allowed tools, confirmation boundary, success state, failure state, handoff conditions, persisted records, and business-side UI outcome.

### Journey 1 — Business information question

Example: “What time do you close today?” or “How much is a consultation?”

Target behavior:

1. Classify as an information intent.
2. Prefer authoritative configuration for facts such as location and configured hours.
3. Use published knowledge for services/pricing/policies where required.
4. Answer only when the source is reliable enough.
5. If the information is missing or conflicting, state that the answer cannot be confirmed and offer human help.
6. Record the resolved outcome without manufacturing a lead unless the customer expresses a real service interest.

### Journey 2 — New-customer appointment request

Example: “Can I book Bella for a vaccination tomorrow afternoon?”

Target behavior:

1. Recognize appointment intent and explicit customer-provided facts.
2. Resolve the requested service to a configured/bookable appointment type without inventing a mapping.
3. Ask only for information genuinely required to search/book.
4. Query live availability.
5. Present a small set of real candidate slots in the business timezone, expressed clearly to the customer.
6. Accept the customer’s slot selection.
7. Prepare a booking intent and revalidate any required state.
8. Obtain the required booking confirmation.
9. Commit through the trusted scheduling capability.
10. Say “booked/confirmed” only after success.
11. Persist/link customer, conversation, appointment, and lead outcome as appropriate.
12. Surface the appointment in the business control center.

### Journey 3 — Slot becomes unavailable during booking

Target behavior:

1. Never convert stale availability into a false confirmation.
2. Explain that the selected time is no longer available without exposing provider internals.
3. Re-query availability.
4. Offer replacement slots.
5. Preserve previously collected non-sensitive context so the customer does not restart the conversation.
6. Escalate only if repeated provider/tool failure prevents a reliable booking.

### Journey 4 — Existing appointment reschedule

Target behavior:

1. Identify the relevant upcoming appointment safely.
2. If multiple appointments match, ask the customer to disambiguate using non-sensitive human-readable details.
3. Check provider/capability support.
4. Retrieve real replacement options.
5. Prepare the reschedule.
6. Show the exact old and new times before commitment.
7. Require explicit confirmation.
8. Commit only through the trusted lifecycle capability.
9. If the provider does not support reschedule, create a human handoff rather than pretending the change is complete.

### Journey 5 — Existing appointment cancellation

Target behavior:

1. Resolve the intended appointment safely.
2. Prepare cancellation.
3. State the exact appointment being cancelled.
4. Require explicit confirmation.
5. Execute through the trusted capability.
6. Confirm cancellation only on success.
7. If state is uncertain, do not tell the customer the appointment is cancelled; escalate with an “outcome unknown” reason.

### Journey 6 — Urgent or safety-sensitive request

Examples vary by industry: possible animal emergency, unsafe vehicle symptoms, medical/contraindication question.

Target behavior:

1. Do not diagnose or provide prohibited safety/clinical judgments.
2. Do not continue ordinary qualification if the industry escalation rule is triggered.
3. Clearly direct the customer toward the business/human pathway defined by policy.
4. Create a high-priority handoff with the customer’s own stated facts.
5. Do not invent severity, diagnosis, treatment, or safety status.

### Journey 7 — Customer asks for a human

Target behavior:

1. Respect an explicit request for human assistance.
2. Create a handoff item immediately unless policy requires an even more urgent path.
3. Tell the customer what can truthfully be promised (for example, that the request has been sent), not an invented response time.
4. Move the conversation out of autonomous AI handling until the product’s return-to-AI condition is satisfied.

### Journey 8 — Knowledge not found / conflicting information

Target behavior:

1. Do not improvise business-specific facts.
2. Distinguish “no reliable answer” from “tool failed”.
3. Ask one useful clarification only if it could materially resolve the ambiguity.
4. Otherwise offer/create human help.
5. Record a knowledge-gap signal so the business can improve its knowledge base later.

### Journey 9 — Lead without immediate booking

Example: “I’m interested in laser treatment but not ready to book.”

Target behavior:

1. Capture only facts the customer actually provided.
2. Do not collect sensitive/clinical information prohibited by the industry pack.
3. Create/update the lead when a real service interest exists.
4. Ask minimal useful qualification questions rather than forcing a booking flow.
5. If the customer does not consent to continue, end cleanly without manufacturing urgency.
6. Surface the lead/follow-up opportunity to the business.

### Journey 10 — Provider/tool outage

Target behavior:

1. Never fabricate availability or success from cached assumptions.
2. Tell the customer the requested action cannot currently be confirmed.
3. Preserve context.
4. Create an actionable handoff or retry work item according to policy.
5. Mark outcome as unresolved rather than failed-completed.

### Journey 11 — Human takeover and resolution

Target behavior:

1. Human sees a concise handoff summary plus full conversation history.
2. Human can claim/assign the work item.
3. Autonomous mutations stop while human control is active.
4. Human actions are visibly attributed to the human, not to AI.
5. Resolution closes the Inbox item while retaining the full history in Conversations.

### Journey 12 — Returning customer

Target behavior:

1. Reuse a safely matched customer identity and prior operational context where policy permits.
2. Do not claim memory of facts that are not present in trusted customer/business records.
3. Show relevant upcoming appointments and history without exposing unrelated records.
4. Avoid duplicate customer creation when a reliable match exists.
5. Create a new conversation and, when appropriate, a new lead/appointment linked to the same customer.

## Locked intent contract

Intent understanding is multi-layered. The agent must not collapse a customer message into one flat label when multiple meanings matter operationally.

### Intent layers

1. **Interrupt** — a signal that may suspend the normal task flow, such as a safety escalation or explicit human request.
2. **Primary task** — the main customer outcome to resolve.
3. **Secondary task** — an additional request that can be handled without corrupting the primary flow.
4. **Modifiers** — details such as date, time preference, subject name, urgency, location, resource preference, or corrections.

### V1 intent taxonomy

- `SAFETY_ESCALATION`
- `HUMAN_REQUEST`
- `CONFIRMATION_RESPONSE`
- `APPOINTMENT_BOOK`
- `APPOINTMENT_RESCHEDULE`
- `APPOINTMENT_CANCEL`
- `APPOINTMENT_LOOKUP`
- `BUSINESS_INFORMATION`
- `SERVICE_INTEREST`
- `COMPLAINT_OR_EXCEPTION`
- `GENERAL_CONVERSATION`
- `OUT_OF_SCOPE`

`LEAD` is not a customer intent. It is a business-side outcome that may result from a genuine `SERVICE_INTEREST`, appointment request, or other qualifying interaction.

### Intent precedence

The locked precedence model is:

```text
interrupts
  ↓
valid pending confirmation / correction state
  ↓
mutating customer tasks
  ↓
read-only customer tasks
  ↓
commercial/service-interest outcomes
  ↓
general conversation
```

Specific rules:

- `SAFETY_ESCALATION` or `HUMAN_REQUEST` may suspend an otherwise valid appointment flow.
- A valid `CONFIRMATION_RESPONSE` is interpreted only against an existing, current pending action in the same conversation context.
- A correction to a pending action invalidates the stale candidate/intent and requires the affected action to be prepared again.
- “Cancel this appointment and book another time” should normalize to `APPOINTMENT_RESCHEDULE` when the same appointment is clearly being moved and the provider capability supports reschedule.
- Secondary read-only questions may be answered during a booking flow when doing so does not weaken action safety or confirmation requirements.

### One pending mutation rule

A conversation may have at most one actionable mutating intent pending confirmation at a time.

If the customer requests multiple distinct mutations, Avenlyo must either:

- normalize them into one supported atomic product operation, such as a reschedule; or
- sequence them as separate prepare → confirm → commit → verify cycles.

A single ambiguous “yes” must never authorize multiple external mutations.

### Intent is not permission

Correctly identifying a task does not grant authority to perform it. Every external or durable action must independently satisfy all applicable gates:

```text
intent understood
  ↓
capability enabled
  ↓
identity sufficient
  ↓
target unambiguous
  ↓
provider capability supports operation
  ↓
product / industry policy allows operation
  ↓
required confirmation is current and valid
  ↓
trusted execution succeeds
```

Only after trusted success may the agent represent the action as completed.

## Phase 22A.2 — Required design outputs

Before implementation begins, the blueprint must be extended with:

1. exact intent taxonomy and precedence rules; **LOCKED**
2. confirmation policy matrix for every agent action;
3. customer identity and disambiguation policy;
4. appointment state machine and concurrency/idempotency rules;
5. human handoff state machine and assignment model;
6. business-side information architecture and screen responsibilities;
7. customer-side channel behavior differences for web chat, SMS, and voice;
8. industry-specific journey deltas for Veterinary, Auto Repair, and Medspa;
9. analytics event/outcome taxonomy for the north-star metric;
10. V1 acceptance scenarios and explicit non-goals.

## Phase 22A.3 — Action confirmation matrix — IN DESIGN

The next locked contract will determine when the agent may observe, prepare, commit, request explicit customer confirmation, require fresh confirmation after a change, or refuse autonomous commit and hand off.

Draft dimensions for each action:

- action name
- action class: observe / prepare / commit / escalate
- external or durable side effect
- identity requirement
- target ambiguity requirement
- explicit confirmation requirement
- confirmation invalidation conditions
- provider/capability preconditions
- success evidence required before customer-facing completion claim
- unknown-outcome behavior
- handoff boundary

Candidate actions to classify in the matrix:

- search/read business information
- search appointment availability
- capture/update a lead
- create a human handoff
- prepare appointment booking
- book appointment
- retrieve upcoming appointments
- prepare appointment reschedule
- execute appointment reschedule
- prepare appointment cancellation
- execute appointment cancellation
- send follow-up/reminder communications where product-authorized
- future customer/profile mutations

## V1 non-goals until explicitly promoted

- generic “any business” onboarding
- autonomous clinical/diagnostic advice
- autonomous vehicle safety assurances
- hidden provider-specific behavior exposed to the customer
- claiming an external action succeeded without trusted success evidence
- production infrastructure work before Product Acceptance is complete

## Exit gate for Phase 22A

Phase 22A is complete only when the product blueprint is specific enough that UI, agent, scheduling, database, and integration work can be implemented without inventing product policy ad hoc in code.

No production deployment authorization is created by completing this phase.
