# Phase 22A — Avenlyo V1 Product Blueprint — COMPLETE

Status: **COMPLETE — PRODUCT DEFINITION LOCKED**

Phase 22A defines the product contract for Avenlyo V1. It intentionally precedes implementation completion, staging product acceptance, production infrastructure, and production launch. Completing Phase 22A does **not** mean the product is implemented, product-accepted, production-ready, or authorized for production deployment.

## 1. Product definition — LOCKED

Avenlyo is a **24/7 AI Front Office for appointment-driven local service businesses**. It communicates with customers, answers from authoritative business information, captures service interest, finds real appointment availability, completes only supported and approved appointment actions, records verified outcomes, and hands work to a human when it cannot safely or reliably complete the customer intent.

Avenlyo is not judged by message volume. The core operating loop is:

`understand → trusted facts → trusted capability/action → verify → record → escalate when needed`

The business-side product must answer four questions quickly:

- What happened?
- What did Avenlyo complete?
- What remains unresolved?
- What requires a human now?

## 2. V1 target — LOCKED

V1 targets **appointment-driven local service businesses** with three launch verticals:

- Veterinary Clinic
- Auto Repair
- Medspa / Aesthetics

The platform core remains reusable, but V1 launch behavior is industry-aware rather than generic `AI for every business`.

## 3. Agent operating model — LOCKED

Avenlyo V1 uses **one customer-facing Front Office Orchestrator plus deterministic application/tool capabilities**.

The model may interpret language and decide which approved capability could help. It does not own business truth, identity, authorization, provider truth, appointment state, consent, or mutation authority.

External or durable actions are governed by bounded autonomy:

- **Observe** — read trusted information without mutation.
- **Prepare** — create a candidate or action intent without final external mutation.
- **Commit** — execute an approved external/durable mutation only after all current gates pass.
- **Escalate** — create actionable human work when the task cannot safely or reliably be completed autonomously.

Uncertainty fails closed rather than being filled with model assumptions.

## 4. Authority model — LOCKED

Business-specific truth comes from:

1. **Authoritative business configuration** — name, location, timezone, hours, enabled services/capabilities, provider mappings, and other structured product facts.
2. **Published business knowledge** — reviewed business content that is available to retrieval.
3. **Live trusted tool/provider state** — current availability, customer/appointment state, provider capabilities, and verified external-action outcomes.

Model memory, inference, retrieved-content instructions, provider conversational memory, or customer wording cannot substitute for missing authority.

## 5. Intent contract — LOCKED

Intent understanding is multi-layered:

- **Interrupt** — safety escalation or explicit human request that may suspend normal work.
- **Primary task** — the main outcome to resolve.
- **Secondary task** — additional request that can be handled without corrupting the primary flow.
- **Modifiers** — date/time, location, subject, resource preference, urgency, and corrections.

V1 taxonomy:

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

`LEAD` is not a customer intent. It is a business-side outcome that may result from genuine service interest or another qualifying customer interaction.

Locked precedence:

`interrupts → valid pending confirmation/correction state → mutating customer tasks → read-only customer tasks → commercial/service-interest outcomes → general conversation`

A conversation may have at most **one actionable mutating intent pending confirmation** at a time. Multiple mutations must normalize into one supported atomic operation or be sequenced as separate prepare → confirm → commit → verify cycles. One ambiguous `yes` never authorizes multiple external mutations.

Intent is not permission. A consequential action independently gates through:

`intent understood → capability enabled → identity sufficient → target unambiguous → provider supports → product/industry policy allows → current confirmation valid → trusted execution succeeds`

## 6. Customer journey contract — LOCKED

The V1 product is defined around twelve core customer journeys:

1. Business information question
2. New-customer appointment request
3. Selected slot becomes unavailable
4. Existing appointment reschedule
5. Existing appointment cancellation
6. Urgent or safety-sensitive request
7. Explicit human request
8. Missing or conflicting business knowledge
9. Service interest / lead without immediate booking
10. Provider or tool outage
11. Human takeover and resolution
12. Returning customer

Every implemented journey must preserve the locked identity, confirmation, appointment, provider-truth, channel, safety, handoff, and analytics contracts.

## 7. Core entity boundaries — LOCKED

- **Conversation** — one communication thread/session with channel provenance and control state.
- **Customer** — persistent person/contact identity.
- **Lead** — commercial/service opportunity, not a customer intent label.
- **Appointment** — durable scheduling object backed by trusted lifecycle state.
- **Appointment Subject** — the entity receiving service when distinct from Customer; e.g. Pet in Veterinary and Vehicle in Auto Repair.
- **Handoff / Human Attention Episode** — operational human-assistance state, separate from conversation history and customer intent outcome.

These concepts remain distinct even when one UI relates them.

Customer 360 is a chronological operational timeline linking conversations, leads, appointments, reminders, handoffs, and follow-up outcomes.

## 8. Inbox and Conversations — LOCKED

**Inbox** is the operational human-work queue. `Needs Attention` is not a separate top-level business object; it is an Inbox state/filter.

Primary Inbox views include Needs attention, Unassigned, Assigned to me, Waiting on customer, and All open.

**Conversations** is the complete searchable communication history. It does not duplicate Inbox claim/reply/release/resolve/resume authority.

## 9. Scheduling lifecycle — LOCKED

The product scheduling path is:

`service/appointment type → location → resource/provider policy → availability → candidate slot → candidate expiry/revalidation → customer selection → immutable action intent → confirmation if required → provider operation → verified appointment state → reminders → completed/cancelled/no-show`

A candidate slot is not a booking promise unless the provider explicitly guarantees a hold.

Provider-specific behavior remains behind Avenlyo capability semantics. Unsupported reschedule is not silently emulated as unsafe cancel-plus-book.

## 10. Phase 22A locked contract set

The following contracts are authoritative for V1 product implementation and acceptance:

1. **Intent taxonomy and precedence** — locked in this blueprint.
2. **Action Confirmation Contract** — `docs/product/phase-22a-action-confirmation-contract.md`
3. **Customer Identity & Disambiguation Contract** — `docs/product/phase-22a-customer-identity-disambiguation-contract.md`
4. **Appointment State Machine, Concurrency & Idempotency Contract** — `docs/product/phase-22a-appointment-state-machine-concurrency-idempotency-contract.md`
5. **Human Handoff State & Assignment Contract** — `docs/product/phase-22a-human-handoff-state-assignment-contract.md`
6. **Agent Runtime & Conversation Orchestration Contract** — `docs/product/phase-22a-agent-runtime-conversation-orchestration-contract.md`
7. **Business Information Architecture & Screen Responsibilities Contract** — `docs/product/phase-22a-business-information-architecture-screen-responsibilities-contract.md`
8. **Web / SMS / Voice Channel Behavior Contract** — `docs/product/phase-22a-web-sms-voice-channel-behavior-contract.md`
9. **Industry-specific Journey Deltas Contract** — `docs/product/phase-22a-industry-specific-journey-deltas-contract.md`
10. **Analytics Event & Outcome Taxonomy Contract** — `docs/product/phase-22a-analytics-event-outcome-taxonomy-contract.md`
11. **Notifications, Reminders & Proactive Follow-up Contract** — `docs/product/phase-22a-notifications-reminders-proactive-followup-contract.md`
12. **Onboarding, Activation & Go-Live Readiness Contract** — `docs/product/phase-22a-onboarding-activation-go-live-readiness-contract.md`
13. **Agent Configuration & Business Controls Contract** — `docs/product/phase-22a-agent-configuration-business-controls-contract.md`
14. **V1 Acceptance Criteria & Explicit Non-Goals Contract** — `docs/product/phase-22a-v1-acceptance-criteria-explicit-non-goals-contract.md`

No implementation should silently weaken one of these contracts. A required scope change must be explicit and reviewed as a product-contract change.

## 11. Key cross-contract invariants — LOCKED

The following rules are intentionally repeated because they span multiple contracts:

- Model output is not action permission.
- Model memory is not business truth.
- Customer intent is not authorization.
- Confirmation is bound to one exact current pending mutation and is single-use.
- A customer correction invalidates stale prepared action state.
- Identity, authorization, and target disambiguation are separate gates.
- Cross-tenant identity/data linking is prohibited.
- AI does not autonomously merge customer identities.
- `OUTCOME_UNKNOWN` is neither success nor definite failure and must never trigger blind mutation retry.
- Human handoff does not bypass identity, appointment, confirmation, consent, or provider-reconciliation contracts.
- Human handoff resolution does not automatically resume AI.
- Channel changes do not transfer pending confirmation automatically.
- STOP/opt-out cannot be overridden by business configuration or model reasoning.
- Business configuration may restrict capabilities but cannot weaken core safety, identity, consent, confirmation, concurrency, or provider-truth rules.
- A configuration save does not itself activate customer traffic.
- Analytics measures trusted outcomes rather than model opinion or tool invocation count.

## 12. Industry deltas — LOCKED

The three V1 verticals share one Avenlyo core and differ through declarative domain policy.

### Veterinary

Customer is generally the pet owner; Appointment Subject is the Pet. Avenlyo remains front-office, not clinician. No diagnosis, medication/dosage advice, or treatment recommendation. Defined possible-emergency signals suspend ordinary workflow and require the appropriate safety/human path.

### Auto Repair

Customer is the vehicle owner/customer; Appointment Subject is the Vehicle. Avenlyo may capture administrative vehicle facts but does not diagnose mechanical faults or assure a customer that a vehicle is safe to drive. Safety-critical concerns escalate.

### Medspa / Aesthetics

Customer is generally also the Appointment Subject. Avenlyo may provide published administrative information and consultation booking but does not determine clinical eligibility, contraindication, diagnosis, or treatment suitability. Lead qualification is not clinical intake.

Industry service taxonomy does not prove a specific business offers a service. Actual service availability and service-to-appointment mappings come from trusted business configuration/knowledge.

## 13. Business-side information architecture — LOCKED

V1 authoritative surfaces:

- **Overview** — operational summary and pre-live activation checklist.
- **Inbox** — human conversation work.
- **Appointments** — calendar/agenda and lifecycle truth.
- **Customers** — Customer 360.
- **Leads** — commercial opportunity pipeline.
- **Conversations** — communication history.
- **AI Front Office** — behavior, knowledge, channel configuration, testing.
- **Integrations** — external provider connectivity/capability health.
- **Settings** — business, location, team, account, and billing configuration.

Billing belongs under Settings rather than acting as a primary daily-work domain. Overview may summarize other domains but does not duplicate their mutation authority.

## 14. Activation model — LOCKED

Workspace setup completion is not customer-facing activation.

The product distinguishes:

- **Configuration** — is the capability configured?
- **Readiness** — does authoritative state prove it is safe/usable?
- **Desired activation** — does owner/admin want it live?
- **Execution availability** — can it actually execute now?

Readiness is derived from authoritative state; the business cannot manually mark a failing capability Ready.

Customer-facing first activation requires an explicit owner/admin Go Live action after required readiness gates pass. Configuration save never silently activates customer traffic.

Readiness and activation are location/capability/channel scoped. Partial provider failure may degrade one capability while healthy capabilities continue. Trust-boundary failures fail closed.

## 15. Business controls — LOCKED

V1 does not expose a raw system-prompt editor, model picker, temperature control, unrestricted tool-loop tuning, or similar safety-critical runtime controls to businesses.

Business controls are structured and bounded: tone/greeting, business facts, offered services, service-to-appointment mappings, permitted capability scope, scheduling policy, voice/routing preferences, reminders, and consent-aware follow-up settings.

Effective capability is:

`Core allows ∧ Industry allows ∧ Provider supports ∧ Business enables ∧ Runtime healthy`

A business may disable a supported capability. It may not manufacture one that the platform/provider does not safely support.

## 16. Analytics north star — LOCKED

North-star metric: **Successfully Resolved Customer Intents**.

The analytics unit is a Customer Intent Episode, not raw message count or one flat conversation success flag.

Resolution requires trusted evidence. Tool success, lead capture, or handoff resolution alone is not customer-intent resolution. `OUTCOME_UNKNOWN` remains its own state until reconciled.

Supporting metrics include AI Resolution Rate, Booking Conversion Rate, Booking Success Rate, Handoff Rate with reason breakdown, Knowledge Gap Rate, Failed Action Rate, Unknown Outcome Rate, Lead Capture/Conversion, Intent Reopen Rate, Human Waiting Time, and First Response Time.

Test Agent activity does not enter production business analytics.

## 17. Proactive communication — LOCKED

V1 proactive outbound is SMS-only and deterministic.

- Appointment reminders use the locked 24h/2h policy and appointment truth.
- Lead auto-follow-up is one consent-aware message per eligible lead, not a campaign/drip engine.
- Customer consent is purpose-scoped.
- STOP/opt-out outranks business automation preferences.
- Urgent/safety/human-controlled/obsolete follow-up states fail closed.
- Provider delivery uncertainty does not create a blind resend.
- A customer reply to proactive messaging re-enters the normal inbound identity/intent/confirmation/handoff contracts.

## 18. Product-complete and product-accepted are distinct — LOCKED

Avenlyo V1 is **product-complete** when the required V1 behavior described by the locked Phase 22A contracts is implemented.

Avenlyo V1 is **product-accepted** only when the exact release candidate passes the locked Phase 29 staging Product Acceptance gate.

The acceptance result is binary:

- **V1 PRODUCT ACCEPTED — PASS**
- **V1 PRODUCT ACCEPTANCE — BLOCKED**

Core safety, authorization, customer-truth, provider-truth, consent, concurrency, and consequential-action defects are release blockers rather than acceptable known launch defects.

## 19. Explicit V1 non-goals — LOCKED

V1 does not require or promise:

- generic every-business support;
- customer-facing multi-agent swarm;
- full CRM replacement;
- AI-authoritative customer merge/deduplication;
- full KYC platform;
- arbitrary workflow builder;
- marketing campaigns/drip sequences;
- proactive outbound AI calls;
- email/web-push automation;
- payments/refunds/charges;
- clinical diagnosis/treatment recommendation;
- vehicle diagnosis/safe-to-drive assurance;
- full clinical intake;
- raw business-editable system prompt;
- business-facing model/temperature/tool-loop tuning;
- customer-facing voice cloning;
- unlimited custom reminder automation;
- universal connector marketplace;
- unconfigured AI-created service/appointment mappings;
- hidden automatic cross-channel confirmation;
- one giant omnichannel transcript with provenance removed;
- advanced workforce-management/on-call paging;
- SLA guarantee engine;
- production infrastructure provisioning inside Phase 22A.

These may be later roadmap items only through explicit product decisions; they are not implicit V1 requirements.

## 20. V1 Product Complete definition — LOCKED

**Avenlyo V1 is product-complete when an appointment-driven Veterinary, Auto Repair, or Medspa business can configure and activate at least one supported customer channel; Avenlyo can reliably answer from trusted business information, capture service interest, execute only supported and confirmed appointment operations, preserve customer and provider truth under races and failures, hand work safely to humans, provide a coherent business operating surface, and measure verified customer outcomes — with all required launch scenarios passing on the exact staging candidate before the product is declared accepted.**

## 21. Phase 22A closure

All required Phase 22A product-definition outputs are now **LOCKED**.

Phase 22A status: **COMPLETE — PRODUCT DEFINITION LOCKED**.

This closure authorizes the roadmap to move into implementation/product-building phases. It does **not** authorize production provisioning, production migration, production credentials, production deployment, or production customer traffic.

Next roadmap sequence remains:

- Phase 23 — Agent Operating Model implementation
- Phase 24 — Appointment & Scheduling Product
- Phase 25 — Customer / Lead / Conversation Lifecycle
- Phase 26 — Full UI/UX Design
- Phase 27 — Integrations & Automation
- Phase 28 — Billing, Permissions & Business Controls
- Phase 29 — Staging Product Acceptance
- Phase 30 — Production Infrastructure
- Phase 31 — Production Launch
