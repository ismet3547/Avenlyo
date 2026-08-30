# Phase 22A — Locked Notifications, Appointment Reminders & Proactive Follow-up Contract

Status: LOCKED

This document is an authoritative companion to the Avenlyo V1 Product Blueprint and the other locked Phase 22A contracts. It defines when Avenlyo may contact a customer proactively, how appointment reminders behave, how follow-up consent is granted and revoked, and which outbound actions are forbidden to model discretion.

Implementation work must not weaken these rules implicitly.

Runtime deployment, production infrastructure, provider provisioning, production credentials, and production data are out of scope.

## Core outbound principle

Avenlyo may not decide on its own to contact a customer later.

> Proactive outbound is a deterministic, server-controlled automation capability governed by trusted business state, consent, eligibility, timing, and provider-delivery policy.

The agent may recognize that a follow-up could be useful, but it is not the authority that sends unsolicited or delayed outbound messages.

## Outbound classes

V1 distinguishes three materially different classes:

| Class | Example | V1 authority |
| --- | --- | --- |
| Transactional appointment reminder | Reminder for a confirmed appointment | Configured reminder policy plus verified appointment truth |
| Customer-requested follow-up | Voice caller asks to receive an SMS later | Purpose-scoped explicit consent |
| Business proactive lead follow-up | Eligible lead receives one later SMS | Explicit consent plus enabled business automation policy |

These classes must not be collapsed into a generic free-form `send_message` agent tool.

## V1 proactive channel scope

V1 proactive outbound is SMS only.

- Web Chat may respond while an active conversation exists, but V1 does not add web push or browser notifications.
- Voice remains inbound; V1 does not permit autonomous outbound AI calls.
- Email is out of scope for V1 proactive messaging.
- Any future outbound channel requires its own capability, identity, consent, delivery, and audit contract.

## Appointment reminder policy

Appointment reminders are deterministic SMS automation.

V1 supports the existing bounded reminder schedule:

- 24 hours before the appointment;
- 2 hours before the appointment.

Reminders are disabled by default and require authorized business configuration.

The product must not expose an unlimited workflow builder for arbitrary reminder offsets in V1.

## Reminder content

V1 reminder text is deterministic or an approved bounded template. It is not free-form LLM output.

Reminder content must:

- identify the business sufficiently for the customer to understand the message;
- state the verified appointment date/time needed for the reminder;
- avoid invented provider, service, availability, or customer facts;
- avoid unnecessary sensitive detail, especially on shared phone numbers;
- avoid clinical, diagnostic, or other industry-sensitive information unless a future explicit policy permits it;
- invite the customer to reply naturally if they need help or a change.

The product must not instruct customers to use `CANCEL` as an appointment-cancellation command because messaging transport policy may interpret it as an opt-out keyword.

## Reminder scheduling and quiet hours

Appointment reminders are time-sensitive.

If the nominal reminder falls inside configured quiet hours, the system may move it only to the closest earlier permitted local instant when that earlier send remains within the reminder's useful window.

A reminder must never be moved later into an invalid or misleading period, and must never be moved to or after the appointment.

If no safe useful time exists, the reminder is omitted rather than sent at an inappropriate time.

Timezone calculations use the location's authoritative IANA timezone and must preserve the existing DST-safe behavior.

## Reminder eligibility

A reminder may be sent only for a future appointment whose current trusted state supports the reminder.

At minimum, the send boundary must revalidate:

- appointment status;
- current appointment start time and applicable schedule version;
- reminder type configuration;
- active sender route;
- verified SMS destination snapshot;
- current opt-out state;
- provider state where provider verification is required;
- relevant billing/entitlement execution authority where applicable.

A stale materialized message must be suppressed rather than submitted when the authoritative state has changed.

## Verified destination snapshot

Appointment reminders use the trusted booking-time SMS recipient snapshot associated with the appointment/reminder.

Later edits to a contact must not silently retarget an already-created reminder to a different phone number.

Appointments without a trusted eligible SMS destination are skipped safely.

## Provider truth before reminder delivery

For provider-backed appointments, the reminder path may use only the existing bounded read/reconciliation capability immediately before materialization.

The reminder system must not:

- create an appointment;
- reschedule an appointment;
- cancel an appointment;
- retry an appointment mutation;
- infer provider state;
- invoke OpenAI to decide whether the appointment exists.

If the current provider truth cannot safely support the reminder, the reminder is skipped or paused according to the appointment state instead of guessing.

## Reschedule invalidates old reminder timing

A provider-confirmed reschedule invalidates reminder timing derived from the old appointment version.

Conceptually:

```text
old confirmed appointment time
        ↓
old reminder schedule
        ↓
provider-confirmed reschedule
        ↓
old schedule invalid
        ↓
recalculate from the new authoritative appointment time
```

The product must not send a reminder for the superseded time.

## Cancellation suppresses future reminders

A provider-confirmed cancellation suppresses all unsent future reminders for that appointment.

If cancellation or reschedule outcome is `OUTCOME_UNKNOWN`, the product must not guess whether a reminder is still correct.

Appointment-affecting reminders are paused/suppressed until reconciliation or human attention produces trusted state.

## Human ownership versus appointment truth

Conversation human ownership alone does not automatically suppress a still-valid transactional appointment reminder.

A staff member may be handling an unrelated question while the verified appointment remains valid.

However, if the active human-attention reason materially affects appointment truth — for example cancellation uncertainty, reschedule uncertainty, appointment identity conflict, or provider inconsistency — appointment reminders must not continue until the state is trusted again.

## Replying to a reminder

A customer's reply to an appointment reminder is a new trusted inbound turn.

The reminder worker itself must not interpret that reply as authority to mutate an appointment.

The normal Avenlyo runtime then applies the existing contracts for:

- identity;
- intent;
- confirmation;
- appointment lifecycle;
- safety;
- handoff;
- provider truth.

## STOP precedence

SMS opt-out has higher precedence than all unsent proactive SMS automation.

When a trusted provider or deterministic keyword path marks the route opted out:

```text
STOP / equivalent trusted opt-out
        ↓
SMS permission revoked
        ↓
applicable unsent proactive SMS suppressed
```

Reminder configuration, follow-up configuration, lead state, or model preference cannot override opt-out.

The LLM is not the authority that interprets, ignores, or reverses provider opt-out state.

## START behavior

A trusted `START`/reactivation signal may restore eligible SMS permission according to messaging policy.

Reactivation does not resurrect stale or already-attempted outbound work blindly.

Any future follow-up must pass the current consent, eligibility, timing, conversation, appointment, and delivery policies again.

## Customer-requested follow-up consent

A customer-requested SMS follow-up requires purpose-scoped explicit consent.

For Voice, the approved pattern is:

```text
prepare follow-up consent intent
        ↓
ask the customer whether they want an SMS follow-up
        ↓
wait for a new caller utterance
        ↓
confirm only on a clear later yes
        ↓
record bounded consent evidence
```

Caller ID or another transport identifier is not itself permission for proactive SMS.

The model must not be given authority to fabricate consent, destination, or evidence.

## Consent scope

V1 proactive SMS consent is bounded by purpose and route.

Conceptually, consent includes:

```text
organization/location
channel = SMS
purpose = LEAD_FOLLOWUP
sender route
recipient route
source evidence
granted_at
status
```

Consent to one follow-up purpose is not consent to unrestricted marketing, campaigns, or unrelated outbound messaging.

Lead capture is not outbound consent.

Possessing a customer record or phone number is not outbound consent.

## Lead follow-up policy

V1 permits at most one automatic lead follow-up per eligible lead.

There is no V1 drip campaign, cadence builder, or automatic multi-step marketing sequence.

The product goal is to prevent one meaningful customer interest from being forgotten, not to become a marketing automation platform.

## Lead follow-up eligibility

An automatic lead follow-up may exist only when trusted state says it is still useful and appropriate.

At minimum, the lead/conversation must remain eligible under conditions equivalent to:

- a real customer-originated lead exists;
- lead status remains suitable for follow-up, such as `new` or `qualified`;
- the lead is not urgent or safety-escalated;
- the lead does not require human handling;
- the conversation remains open and under AI control;
- there is no active/open human handoff;
- there is no already-confirmed appointment that makes the follow-up obsolete;
- there is no pending, executing, or unknown booking/appointment-change operation;
- business follow-up automation is enabled and acknowledged;
- the configured sender is still active and eligible;
- purpose-scoped consent is active;
- SMS opt-out is not active;
- the triggering customer message remains the relevant latest trigger;
- no newer meaningful customer, human, or automation message has made the follow-up stale;
- a valid allowed send window exists.

If any authoritative condition becomes false, the follow-up is skipped or suppressed rather than sent.

## Newer conversation activity invalidates stale follow-up

If the customer or a human meaningfully continues the conversation after the follow-up trigger, the previously scheduled follow-up becomes obsolete.

Example:

```text
12:00 customer asks about service
12:05 lead captured
16:00 follow-up scheduled
14:30 customer replies
        ↓
16:00 follow-up must not send
```

The customer must never receive a stale message such as “Are you still interested?” after they already continued the conversation.

## Confirmed appointment invalidates lead follow-up

Once the lead's relevant work has produced a confirmed appointment, the automatic lead follow-up is obsolete.

The system must not later ask whether the customer still wants to book when a trusted confirmed appointment already exists.

## Safety and human-attention precedence

Industry safety rules outrank proactive automation.

Examples:

- Veterinary emergency/urgent concern → no auto lead follow-up; human/safety path.
- Auto Repair safety-critical concern → no auto lead follow-up; human/safety path.
- Medspa clinical eligibility/contraindication concern → no auto lead follow-up; human/clinical path.

The system must not use delayed outbound automation to bypass a prior safety or human-control decision.

## Lead follow-up timing

Lead follow-up is not time-critical in the same way as an appointment reminder.

Therefore quiet-hour handling is different:

- appointment reminder: may move earlier when still useful;
- lead follow-up: moves to the next permitted time, never earlier than its intended delay.

V1 lead follow-up should default to business-hours-only behavior unless an explicitly approved product setting says otherwise.

The location timezone and business hours remain authoritative.

## Lead follow-up content

V1 automatic lead follow-up uses deterministic/approved bounded templates, not free-form LLM-generated outreach.

A follow-up may reference safe known context, such as the business and a bounded service-interest label, when that context is trusted.

It must not contain live facts that require fresh provider or knowledge lookup, such as claiming a slot is still available.

If the customer replies, current availability or other live facts are retrieved through the normal runtime at that time.

## No generic proactive-send agent tool

The agent may not independently call a generic delayed/proactive `send_sms` operation.

Actual proactive outbound authority follows this sequence:

```text
trusted trigger
   ↓
automation policy
   ↓
consent policy
   ↓
eligibility revalidation
   ↓
timing policy
   ↓
durable delivery claim
   ↓
provider submission boundary
```

This keeps proactive messaging deterministic and auditable.

## Delivery state and unknown outcomes

The existing SMS delivery state machine remains authoritative.

Materializing an outbound message does not mean it was delivered.

Provider outcomes such as submitted, sent, delivered, failed, undelivered, suppressed, and unknown remain distinct.

If a provider submission is ambiguous after the send boundary, the system records an `unknown` outcome and must not blindly resend.

Conceptually:

```text
provider submit starts
      ↓
result ambiguous
      ↓
DELIVERY_UNKNOWN
      ↓
NO BLIND RESEND
```

A retry is allowed only if a future explicit reconciliation/idempotency contract proves it safe.

## Deterministic automation versus LLM

Appointment reminders and automatic lead follow-ups do not require an LLM call in V1.

The LLM may participate only after a new customer inbound message enters the normal orchestrator.

This preserves:

- content consistency;
- consent boundaries;
- deterministic safety;
- lower cost;
- lower hallucination risk;
- clearer auditability.

## Analytics expectations

Proactive outbound analytics must distinguish at least:

- reminder scheduled;
- reminder suppressed/skipped;
- reminder delivery submitted/sent/delivered/failed/unknown;
- follow-up consent granted/revoked;
- lead follow-up scheduled;
- lead follow-up skipped/suppressed;
- lead follow-up delivery submitted/sent/delivered/failed/unknown;
- customer reply after proactive message.

These events do not by themselves prove customer-intent resolution. The locked Analytics Contract remains authoritative for product outcome metrics.

## Locked V1 decisions

The following are authoritative V1 product decisions:

1. Appointment reminders are configured 24-hour/2-hour deterministic SMS automation.
2. Reminder content is approved/deterministic template content, not free-form model output.
3. Reminder delivery requires current trusted appointment truth and current messaging permission.
4. Provider-confirmed reschedule invalidates old reminder timing and recalculates from the new appointment state.
5. Provider-confirmed cancellation suppresses future reminders.
6. Appointment lifecycle `OUTCOME_UNKNOWN` must not be guessed; affected reminders pause/suppress until trusted state returns.
7. STOP/opt-out overrides all unsent applicable proactive SMS automation.
8. Lead capture or possession of a phone number is not outbound consent.
9. Customer-requested SMS follow-up requires purpose-scoped explicit consent.
10. V1 automatic lead follow-up is at most one message per eligible lead; no drip campaign exists.
11. Urgent, safety, human-controlled, pending/unknown booking, confirmed-appointment, or newer-conversation states suppress lead follow-up when they make it inappropriate or obsolete.
12. Appointment reminders may move earlier around quiet hours only within their useful window; lead follow-up moves later to the next allowed window and is never moved earlier.
13. V1 proactive outbound content is deterministic/approved template content.
14. Ambiguous provider SMS submission becomes `unknown` and is never blindly resent.
15. V1 proactive outbound channel is SMS only.
16. Any customer reply to a proactive message becomes a new normal inbound turn governed by the Identity, Intent, Confirmation, Safety, Handoff, Appointment, Channel, and Provider Truth contracts.
17. Proactive messaging is deterministic automation, not a generic LLM-controlled delayed-send capability.

These rules are part of the Avenlyo V1 product contract and may be changed only through an explicit product-contract revision.
