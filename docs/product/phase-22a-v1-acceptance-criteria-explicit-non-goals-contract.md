# Phase 22A — V1 Acceptance Criteria & Explicit Non-Goals Contract — LOCKED

Status: **LOCKED**

This contract defines when Avenlyo V1 may be called product-complete and product-accepted. Feature implementation, a working page, a passing unit test, or a successful demo is not sufficient. V1 Product Acceptance requires the exact release candidate to prove the required customer journeys, safety boundaries, business-truth guarantees, failure handling, channel semantics, business operations, and analytics outcomes on real staging.

## 1. Four distinct gates

Avenlyo uses four separate gates:

1. **Product Defined** — required V1 product contracts are locked.
2. **Product Implemented** — required UX, backend, tool, policy, provider, and state behavior is implemented.
3. **Product Accepted** — the exact candidate passes the required product-acceptance suite on real staging.
4. **Production Ready** — production infrastructure, data, security, observability, DNS/TLS, backup/recovery, credentials, and launch-specific requirements are independently ready.

Product Accepted is not production-deploy authorization.

## 2. Acceptance is exact-candidate specific

Product acceptance applies to one exact release candidate SHA and its immutable runtime artifacts.

The acceptance chain is:

`exact candidate SHA → required CI → immutable artifacts → real staging → product acceptance suite → PASS or BLOCKED`

Any later code, dependency, migration, workflow, runtime configuration, Docker/Compose/Caddy, or other behavior-affecting change invalidates acceptance for the previous candidate as a launch binary and requires a new candidate to pass the relevant gates again.

Documentation-only changes do not change runtime behavior but must still remain internally consistent with the accepted product contract.

## 3. Evidence requires multiple layers

No single test layer is sufficient. V1 acceptance requires evidence from all applicable layers:

- **Contract/unit tests** for schemas, validators, deterministic policies, state transitions, normalization, and guardrails.
- **Database/service integration tests** for tenant boundaries, atomic claims, idempotency, concurrency, durable transitions, ownership, and provider-operation semantics.
- **Real staging end-to-end tests** across the actual web/API/database runtime and the supported channel/provider surfaces.
- **Human product review** for information architecture, state clarity, confirmation clarity, failure messaging, operational usability, and trustworthiness.

Human review does not override a failing deterministic safety or business-truth invariant.

## 4. Onboarding and activation acceptance

A new business must be able to complete the supported journey without manual database intervention:

`sign up → industry → business → location → website source → workspace setup → activation checklist → knowledge → services → provider/channel configuration → Test Agent → readiness → explicit Go Live`

Acceptance must prove that:

- Workspace Setup Complete, Ready, Desired Live State, and Current Execution Availability remain distinct.
- configuration changes do not silently activate customer traffic;
- explicit owner/admin activation is required for customer-facing go-live;
- blockers explain why the location or capability cannot go live;
- billing/provider pauses do not erase business configuration;
- business pause/resume is safe and readiness is re-evaluated on resume;
- readiness and activation are location-scoped in multi-location organizations.

## 5. Business-side information architecture acceptance

The following authoritative responsibilities must be implemented coherently:

- **Overview** — cross-product operational summary: what happened, what Avenlyo completed, what remains unresolved, and what needs human attention.
- **Inbox** — the single authoritative human conversation-work surface.
- **Appointments** — appointment calendar/agenda and appointment lifecycle truth.
- **Customers** — Customer 360 and persistent customer operational timeline.
- **Leads** — commercial/service opportunity pipeline.
- **Conversations** — searchable communication history, not a second operational Inbox.
- **AI Front Office** — agent behavior, business knowledge, channel controls, and safe testing.
- **Integrations** — external provider connectivity, capability state, and health.
- **Settings** — business, location, team, account, and billing configuration.

`Needs Attention` is not a duplicate top-level business object. Cross-surface links must preserve authoritative ownership: Inbox to Customer, Appointment, Lead, Conversation history, and related objects; Customer 360 must link back to the authoritative domain surfaces.

Overview may summarize domain information but must not create duplicate mutation implementations for reply/claim/booking/lifecycle operations.

## 6. Knowledge acceptance

V1 Business Knowledge must prove the lifecycle:

`Import → Draft → Human Review → Publish → Retrieval`

Acceptance requires:

- draft sources are not retrieved as published authority;
- archived sources are not retrieved as active authority;
- published business facts are retrievable;
- missing reliable business-specific evidence causes safe uncertainty rather than invention;
- website/retrieved content cannot override platform, industry, business-policy, or tool-authority instructions;
- prompt-injection-like text inside retrieved business content is treated as untrusted reference data, not executable instruction.

## 7. Agent runtime acceptance

Customer-facing runtime must consistently follow:

`trusted context → intent understanding → approved capability → trusted result → customer response`

It must not follow:

`model guess → external mutation`

The suite must exercise at least:

- business-specific hallucination attempts;
- unavailable or non-existent tools;
- disabled capabilities;
- multi-intent turns;
- customer corrections;
- prompt-injection attempts in knowledge/reference data;
- model-provider failure;
- tool/provider failure;
- human takeover while model execution is in flight;
- successful consequential tool execution followed by final response-generation failure;
- bounded context/tool-loop behavior.

A successful durable external mutation remains true even if final language generation fails. The model may not claim completion without trusted success evidence. Provider-side conversational memory is never the authority for Avenlyo durable business state.

## 8. Identity, privacy, and disambiguation acceptance

Acceptance must prove:

- Web sessions begin anonymous unless identity is established through a trusted product flow.
- SMS and Voice trusted transport identifiers may create channel-bound identity context but are not universal proof of the human behind the channel.
- name-only, pet-name-only, vehicle-only, or fuzzy matching cannot authorize destructive or sensitive operations.
- multiple plausible matches fail closed into minimal disambiguation or human assistance.
- customer existence is not leaked to unauthenticated/insufficiently identified users.
- cross-tenant access is impossible.
- cross-location access is limited to authorized scope.
- existing appointment lookup and mutation require sufficient identity/authorization plus an unambiguous target.
- Pet/Vehicle subject data may disambiguate appointment targets but is not itself customer identity proof.
- AI cannot autonomously merge customer records or transfer customer identity ownership.

## 9. New appointment booking acceptance

The normal V1 booking path is:

`intent → availability → candidate → prepare → exact customer-facing summary → explicit confirmation → provider commit → trusted success → durable appointment → customer success message`

Required concurrency and correctness cases include:

- two customers see the same slot and authoritative commit arbitration prevents double booking;
- duplicate Confirm clicks produce one logical external mutation;
- two workers processing the same confirmation produce one claimant;
- an expired candidate cannot be committed;
- customer corrections invalidate the stale prepared action;
- one ambiguous `yes` cannot authorize multiple mutations;
- internal candidate/intent/provider identifiers are not exposed to customers;
- a prepared candidate is not represented as a reserved/confirmed appointment unless the provider actually provides that guarantee.

## 10. Appointment lookup, reschedule, and cancellation acceptance

Existing appointment operations require exact appointment targeting and current authoritative state.

Acceptance must prove:

- reschedule confirmation displays the exact old-to-new change;
- cancellation confirmation displays the exact target;
- a staff/provider change after preparation makes a stale version ineligible to commit;
- simultaneous mutations against the same appointment/version are deterministically arbitrated;
- unsupported reschedule is not secretly emulated as unsafe cancel-plus-book and described as a successful reschedule;
- already-final/idempotent lifecycle operations do not generate duplicate provider mutations.

If provider outcome is `OUTCOME_UNKNOWN`, Avenlyo must not claim success or failure and must not blindly retry. Reconciliation and/or human attention is required.

## 11. Appointment reminders acceptance

Acceptance must prove:

- reminders apply only to authoritative eligible future appointments under configured policy;
- 24-hour and 2-hour V1 timing behaves according to location timezone;
- quiet-hours adjustment follows the locked reminder policy;
- successful reschedule invalidates old reminder timing and recalculates from the new appointment state;
- confirmed cancellation suppresses future reminders;
- unknown appointment lifecycle outcomes pause/suppress state-dependent reminders until truth is reconciled;
- STOP/opt-out suppresses applicable unsent proactive SMS;
- ambiguous provider delivery does not create a blind duplicate resend.

## 12. Human handoff acceptance

At minimum, the following lifecycle must pass under real race conditions:

`customer requests human → handoff created/reused → AI paused → unassigned human queue → atomic claim → human reply → AI suppressed → resolve handoff → AI still paused → explicit Resume AI → no unsolicited resume message → next customer inbound may re-enter AI`

Acceptance must also prove:

- requesting human is not the same as assigning a human;
- two simultaneous claims result in one owner;
- same-owner claim replay is idempotent;
- non-owner reply-over/claim-over is rejected;
- release does not resume AI;
- resolve does not resume AI;
- Voice Inbox claim does not falsely imply a live call transfer;
- queued AI messages are suppressed at the appropriate ownership boundary while already-submitted provider truth is preserved;
- customer waiting is bounded to the current human-attention episode;
- provider-outcome-unknown handoff does not authorize a blind retry of the original mutation.

## 13. Channel acceptance

All supported launch channels must preserve the same core identity, confirmation, appointment, handoff, provider-truth, and safety contracts.

### Web

Acceptance requires opaque session handling, exact origin policy, anonymous-by-default identity semantics, structured candidate/confirmation UX where implemented, and stale confirmation controls that cannot commit an invalid action.

### SMS

Acceptance requires authenticated/trusted provider ingress, inbound event replay dedupe, deterministic STOP/START handling, short text confirmation UX, correct route-bound identity context, and durable provider delivery state.

### Voice

Acceptance requires AI disclosure, short spoken turns, one-question-at-a-time behavior where practical, explicit new caller confirmation for consequential mutations, caller interruption handling, transfer-vs-handoff separation, and disconnect never being treated as implicit confirmation.

## 14. Cross-channel acceptance

A pending consequential action prepared in one channel must not be silently committed by an ambiguous confirmation arriving on another channel.

New-channel continuation requires:

`identity resolution → current action reload → current-state revalidation → action re-summary → fresh confirmation on the new channel`

Customer 360 may relate multiple Web/SMS/Voice conversations to the same safely resolved customer, but channel provenance must remain visible and authoritative events must not be collapsed into an untraceable single transcript.

## 15. Veterinary acceptance

Minimum Veterinary acceptance classes include:

- routine business information;
- vaccination/service interest;
- normal booking;
- two-pet target ambiguity;
- appointment lookup/reschedule/cancellation;
- possible emergency/safety escalation;
- medication/dosage/treatment-advice request;
- requested service not offered.

Possible-emergency scenarios must suspend ordinary workflow as required, must not produce clinical diagnosis, medication/dosage advice, or treatment recommendations, and must invoke the required human/safety path.

## 16. Auto Repair acceptance

Minimum Auto Repair acceptance classes include:

- maintenance/service inquiry;
- estimate interest;
- service-visit booking;
- two-vehicle target ambiguity;
- appointment lifecycle;
- brake/steering or similar safety concern;
- `is it safe to drive?` request;
- requested service not offered.

Avenlyo must not diagnose the vehicle or assure the customer that it is safe to drive.

## 17. Medspa acceptance

Minimum Medspa acceptance classes include:

- published treatment/service information;
- published pricing;
- consultation booking;
- appointment lifecycle;
- treatment/service interest;
- clinical-eligibility question;
- contraindication question;
- `which treatment is right for me?` request.

The agent may perform front-office/commercial qualification but must not conduct autonomous clinical intake, determine eligibility/contraindication, diagnose, or recommend a treatment as medically suitable. Sensitive medical-history fields must not be collected merely to improve lead completeness.

## 18. Lead acceptance

Acceptance must prove:

- durable lead creation from genuine customer service interest;
- only customer-stated facts are captured by the AI lead tool;
- Lead remains a business-side outcome/object, not a customer intent label;
- Lead does not automatically create human attention;
- confirmed appointment can produce the appropriate lead conversion state;
- confirmed booking makes obsolete booking-oriented proactive follow-up ineligible.

## 19. Proactive follow-up acceptance

V1 proactive lead follow-up remains a single consent-aware SMS automation, not a campaign engine.

Acceptance must prove:

- no applicable outbound follow-up without required purpose-scoped consent;
- urgent/safety/human-required leads are not auto-followed-up;
- human-owned conversations suppress automatic lead follow-up;
- newer meaningful customer/human activity invalidates obsolete scheduled follow-up;
- confirmed appointment invalidates obsolete booking-oriented follow-up;
- quiet hours/business-hours policy moves follow-up to the next permitted window;
- provider delivery uncertainty does not create a blind resend.

## 20. Analytics acceptance

Analytics must measure authoritative outcomes, not model opinion.

The suite must prove:

- `tool succeeded` alone is not customer-intent resolution;
- `lead captured` alone is not customer-intent resolution;
- `handoff resolved` alone is not customer-intent resolution;
- `OUTCOME_UNKNOWN` is not silently classified as success or definite failure;
- Test Agent activity does not enter production business metrics;
- duplicate logical provider/webhook/inbound replays do not double-count the same business outcome;
- booking conversion and booking-operation reliability remain distinct;
- AI, HUMAN, MIXED, and SYSTEM resolution actors can be distinguished where applicable;
- resolved intent episodes can be reopened when subsequent evidence shows the task was not actually complete.

## 21. Authorization and secrets acceptance

Authorization must be enforced server-side, not only by hidden UI controls.

Acceptance requires:

- members cannot perform owner/admin-only configuration through direct requests;
- authorized operational roles can perform their intended Inbox/customer/appointment work;
- tenant/location identifiers supplied by a client cannot broaden authorization scope;
- secrets, provider credentials, protected routing values, internal tool schemas, and internal identifiers are not exposed through normal customer/business UI responses.

## 22. Go-live acceptance

First customer traffic may be activated only when the locked readiness rules pass.

At minimum:

- at least one customer channel is Ready;
- human fallback is Ready;
- trusted business knowledge is Ready;
- each enabled consequential capability is Ready;
- required vertical-aware Agent Test/readiness scenarios pass;
- active execution entitlement is available for first activation;
- explicit owner/admin Go Live action is recorded;
- configuration save alone does not activate customer traffic.

A location may go live with a limited supported capability set when scheduling is intentionally disabled/unavailable, but the product must make that limitation explicit and the agent must not imply booking capability exists.

## 23. Degraded-state acceptance

The product must remain truthful under partial failure.

A provider outage may degrade one capability while healthy capabilities continue. For example, Business Knowledge, Lead Capture, and Handoff may remain healthy while Scheduling is `DEGRADED`.

The agent must not invent appointment success while the scheduling provider is unavailable.

Security, tenant-routing, channel-identity, or comparable trust-boundary failures may require the affected channel/capability to fail closed rather than continue in degraded autonomous mode.

## 24. Release-blocking defect classes

A known open defect in any of the following classes blocks V1 Product Acceptance:

- cross-tenant data exposure;
- wrong-customer or wrong-appointment mutation;
- duplicate consequential external mutation;
- false booking/reschedule/cancellation success;
- blind retry after an unknown provider outcome;
- consent or STOP violation;
- AI speaking/sending over established human ownership;
- required safety escalation bypass;
- prohibited clinical or vehicle-safety advice in required acceptance scenarios;
- configuration save accidentally activating customer traffic;
- draft/untrusted knowledge being treated as instruction or authoritative published business truth;
- materially false critical business-outcome analytics.

Cosmetic issues and non-critical polish defects may be triaged separately, but core safety, authorization, customer-truth, provider-truth, and consequential-action defects are not waived as `good enough` for an accepted launch candidate.

## 25. Binary acceptance result

Phase 29 produces one of two product-gate outcomes for the exact candidate:

- **V1 PRODUCT ACCEPTED — PASS**
- **V1 PRODUCT ACCEPTANCE — BLOCKED**

`Mostly pass`, `works locally`, or `acceptable except for known core defects` are not valid gate results.

A blocking failure requires a fix, a new/revalidated candidate as applicable, and re-execution of the relevant acceptance evidence.

## 26. Explicit V1 non-goals

The following are intentionally outside V1 Product Acceptance unless a later locked contract explicitly changes scope:

- generic support for every business vertical;
- customer-facing multi-agent swarm or autonomous agent team;
- full CRM replacement;
- AI-authoritative customer merge/deduplication;
- full KYC/identity-verification platform;
- arbitrary no-code workflow builder;
- marketing campaign or multi-step drip/nurture sequences;
- proactive outbound AI voice calls;
- email automation;
- web/mobile push automation;
- payments, charges, refunds, or financial mutation flows;
- Veterinary/Medspa clinical diagnosis, treatment recommendation, medication/dosage advice, or autonomous eligibility determination;
- Auto Repair vehicle diagnosis or safe-to-drive assurance;
- full clinical intake or medical-record workflow;
- raw business-editable system prompt;
- business-selectable model, temperature, tool-loop limits, or unrestricted runtime tuning;
- custom customer-facing voice cloning;
- unlimited/custom reminder automation beyond the locked V1 reminder policy;
- universal connector marketplace;
- AI-created service/appointment mapping without trusted business/provider configuration;
- hidden automatic cross-channel confirmation;
- one giant omnichannel transcript as the sole authority with channel provenance removed;
- advanced workforce-management/on-call paging system;
- contractual SLA-guarantee engine;
- production infrastructure provisioning as part of Phase 22A.

A non-goal does not mean `never`. It means V1 acceptance does not depend on that capability and the capability must not be smuggled into V1 in a way that weakens locked contracts.

## 27. V1 Product Complete definition

Avenlyo V1 is product-complete when an appointment-driven Veterinary, Auto Repair, or Medspa business can configure and activate at least one supported customer channel; Avenlyo can reliably answer from trusted business information, capture service interest, execute only supported and confirmed appointment operations, preserve customer and provider truth under races and failures, hand work safely to humans, provide a coherent business operating surface, and measure verified customer outcomes — with all required launch scenarios passing on the exact staging candidate.

## 28. Locked summary

V1 Product Acceptance is based on verified customer work and business truth, not feature count or demo quality.

The immutable acceptance principles are:

- exact-candidate evidence;
- required multi-layer testing;
- no core safety/business-truth defect waiver;
- explicit channel/vertical/failure acceptance;
- deterministic acceptance of consequential operations and human handoff;
- authoritative analytics outcomes;
- explicit V1 non-goals and scope discipline;
- binary PASS/BLOCKED product-gate result.
