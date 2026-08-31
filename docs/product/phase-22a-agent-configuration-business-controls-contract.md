# Phase 22A — Agent Configuration & Business Controls Contract — LOCKED

Status: **LOCKED**

This contract defines what an Avenlyo business may configure and what remains platform-owned policy. Business controls may shape business-specific presentation, services, routing, and permitted operating scope, but they may not weaken Avenlyo core safety, identity, authorization, confirmation, consent, provider-truth, concurrency, or human-ownership rules.

## 1. Policy precedence

Runtime policy is layered in this order:

1. **Avenlyo Core Policy**
2. **Industry Policy**
3. **Business Controls**
4. **Live Runtime State**

A lower layer may specialize or further restrict a higher layer. It may not weaken or override it.

Core platform rules include identity, authorization, confirmation, provider truth, tool authority, safety, human ownership, consent, idempotency, unknown-outcome handling, and tenant isolation. Industry policy adds domain constraints. Business controls express legitimate business preferences. Live runtime state is the current authoritative system condition and cannot be overwritten by configuration.

## 2. No raw system-prompt editor in V1

V1 must not expose a free-form `Custom Prompt` or raw system-prompt editor to business users.

Repeated important business instructions should be modeled as structured product facts or policies rather than prompt text. Examples include business hours, service availability, appointment mappings, new-client policies, reminder settings, handoff routing, and published business knowledge.

## 3. Communication style is bounded

Business-facing tone configuration must use bounded presentation presets such as `Professional`, `Warm`, `Concise`, or similar source-controlled options.

Tone may change wording and presentation. It may not change facts, safety behavior, identity requirements, confirmation requirements, tool permissions, provider truth, or handoff obligations.

Channel-specific greetings may be business-configurable within bounded product limits. Greetings are customer-facing copy, not agent instructions.

## 4. Business facts are structured authority

Business name, location, address, phone, timezone, business hours, and website are authoritative structured configuration. The agent consumes them as trusted business context.

Businesses must update the underlying structured fact rather than inserting contradictory prompt text. Business-specific knowledge that is not structured configuration must come from the approved knowledge system and remain subject to review/publish rules.

## 5. Services and mappings are business-owned policy

The business may configure actual services offered by a location. A service can include, conceptually:

- name
- active/inactive status
- customer-facing description reference
- bookable yes/no
- appointment-type mapping
- location availability

Industry service categories are normalization taxonomy only; they do not prove that a specific business offers a service.

Service-to-appointment mappings are trusted business configuration. The model may not invent or infer a booking mapping that has not been configured or returned by an authoritative service.

## 6. Effective capability is an intersection

An effective customer-facing capability exists only when all relevant gates allow it:

`Core allows ∧ Industry allows ∧ Provider supports ∧ Business enables ∧ Runtime healthy`

The business may disable an otherwise-supported capability. It may not create a capability the platform, industry policy, provider, or current runtime does not safely support.

For example, a provider may support rescheduling while the business disables AI rescheduling. The effective capability is disabled. Conversely, enabling a business toggle cannot manufacture provider rescheduling support.

## 7. Scheduling controls

Business-configurable scheduling policy may include:

- which services are bookable
- which appointment types may be offered
- which locations are eligible
- which resources/calendars are eligible
- minimum lead time
- whether AI may book
- whether AI may reschedule
- whether AI may cancel

The following are not business-configurable:

- candidate-expiry semantics
- atomic claim behavior
- confirmation requirements
- provider reconciliation rules
- idempotency semantics
- unknown-outcome handling

The UI should distinguish provider capability from Avenlyo automation policy. For example, `Provider capability: Supported` and `Avenlyo automation: Disabled` are separate facts.

## 8. Handoff controls are bounded

A business may choose legitimate routing preferences and may opt for a more conservative human-assistance posture. It may not configure `Never hand off` or otherwise suppress mandatory handoff conditions.

Mandatory handoff triggers include, where applicable:

- explicit human request
- safety escalation
- provider outcome unknown
- unresolved identity ambiguity
- unresolved target ambiguity
- unsupported consequential capability

Operational routing such as Inbox ownership policy or a trusted voice-transfer target is structured configuration, not model-visible free-form instruction.

## 9. Voice controls

Voice selection is a presentation control and does not affect business authority or safety policy. A business may configure approved voice options and, where supported, live transfer enablement and a trusted transfer target.

Trusted transfer numbers and equivalent routing secrets are not agent prompt content and need not be exposed to the model.

Arbitrary voice cloning, arbitrary speaker personas, or unbounded voice prompting are outside V1 scope.

## 10. Web Chat controls

Business-configurable Web Chat settings may include:

- configured/enabled intent
- exact allowed origins
- bounded welcome message

Opaque session security, origin-validation behavior, tenant routing, token security, and message idempotency are platform-owned and not configurable.

## 11. Reminder controls

Business-configurable V1 appointment-reminder controls may include:

- enable/disable reminder automation
- approved 24-hour reminder
- approved 2-hour reminder
- quiet hours

The business may not disable appointment-truth revalidation, STOP precedence, unknown-outcome suppression, or provider delivery idempotency.

V1 reminder content remains deterministic/approved rather than a free-form business prompt.

## 12. Lead follow-up controls

Business-configurable lead-follow-up controls may include:

- enable/disable one consent-aware follow-up
- approved sender route
- delay
- quiet hours
- business-hours-only behavior

The business may not disable customer consent requirements, opt-out handling, urgency/safety exclusions, one-follow-up V1 scope, or provider delivery safety rules.

## 13. Consent is not a business toggle

Customer consent is authoritative customer-derived state. Business configuration only determines whether the business wishes to use a capability when valid consent exists.

`Business enabled = true` and `Customer consent = false` must produce no proactive outbound message.

STOP and equivalent deterministic messaging opt-out state cannot be overridden by any business setting.

## 14. Knowledge safety boundary is fixed

Owners/admins may import, review, publish, and archive approved business knowledge. They may not configure the agent to retrieve drafts or archived sources as authoritative customer-facing facts.

Retrieved knowledge remains untrusted reference data with respect to instructions. Content inside a source cannot override Avenlyo policy.

## 15. Agent Behavior surface

`AI Front Office → Behavior` should expose bounded business controls and summaries, not duplicate every domain configuration surface.

A V1 presentation may include:

- communication tone
- Web greeting
- Voice greeting
- voice selection
- whether supported customer operations such as booking/reschedule/cancel are enabled
- standard human-assistance posture
- live transfer summary
- links to appointment reminders and lead follow-up configuration

Detailed provider configuration stays in Integrations/Appointments. The Behavior surface may summarize and deep-link rather than duplicate underlying authoritative settings.

## 16. Core invariants are not feature toggles

The following must never appear as ordinary business-configurable switches:

- require confirmation
- verify identity
- prevent duplicate booking
- respect STOP
- protect secrets/internal IDs
- prohibit diagnosis or clinical eligibility decisions
- prohibit unsafe vehicle assurances
- never blind-retry unknown outcomes
- suppress AI while a human owns the conversation
- provider-truth and reconciliation semantics

These are product invariants, not optional features.

## 17. Configuration changes and readiness

Configuration changes fall into two broad classes.

Presentation-only changes such as tone, greeting, or voice can generally apply to future turns/sessions without changing business authority.

Capability-affecting changes such as disabling booking, changing appointment mappings, disconnecting a provider, changing allowed origins, or enabling a customer-facing channel must trigger readiness re-evaluation. A location/capability may move between `READY`, `DEGRADED`, and `BLOCKED` according to the locked activation/readiness contract.

## 18. Current policy must be revalidated at commit

A prepared action does not preserve stale business authority.

If a consequential action was prepared while a capability was enabled, but the business disables that capability before customer confirmation, the old action may not commit merely because it was prepared earlier.

Commit gates must revalidate current capability, provider support, identity, target, product/industry policy, current confirmation, and trusted execution state.

## 19. Policy version awareness

Implementations should support version-aware validation for business policy where stale configuration could cause unsafe or incorrect behavior, particularly service mappings and consequential appointment capabilities.

This does not require a single monolithic configuration row, but consequential operations must not rely on stale policy as authority.

## 20. Save, verify, and activate for high-impact controls

Not every low-risk setting requires draft/publish semantics. However, high-impact changes such as customer-channel activation, service-to-appointment mapping, provider switching, and automation activation must respect the broader `configure → verify → ready → activate` model from the locked go-live readiness contract.

## 21. Roles and authorization

Agent/business configuration is owner/admin scope in V1. Normal members may perform authorized daily operations but do not change policy/configuration by default.

UI visibility is not authorization. Server/database authorization remains authoritative.

## 22. Audit

Meaningful business-configuration changes should produce bounded, PII/secrets-minimized audit records that identify the actor, location, and semantic policy change.

Examples include tone changes, capability enable/disable decisions, Web Chat configuration changes, voice-transfer changes, reminder changes, and lead-follow-up changes.

Audit metadata must not unnecessarily copy credentials, raw secrets, full customer data, or sensitive routing information.

## 23. Platform runtime tuning is not a business control

V1 does not expose a business-facing model picker, temperature control, unbounded tool-loop limits, token budgets, retry algorithms, or other raw model/runtime tuning.

Model/runtime selection remains platform-owned because it is part of the reliability and safety envelope.

## 24. Locked invariants

The following decisions are authoritative for V1:

1. V1 has no raw/custom system-prompt editor.
2. Communication style uses bounded tone presets and channel-specific greetings.
3. Business facts are structured authoritative configuration/approved knowledge, not prompt hacks.
4. Services and service-to-appointment mappings are business-owned trusted configuration.
5. Effective capability equals Core allows ∧ Industry allows ∧ Provider supports ∧ Business enables ∧ Runtime healthy.
6. A business may further restrict capability but cannot create unsupported authority.
7. Identity, authorization, confirmation, safety, consent, human ownership, idempotency, and unknown-outcome rules are not user-editable.
8. Scheduling, reminders, and follow-up remain bounded structured controls.
9. STOP and customer consent cannot be overridden by business policy.
10. Knowledge publication/retrieval safety cannot be bypassed by business configuration.
11. Capability-affecting changes re-run readiness evaluation.
12. Consequential commits revalidate current business policy; stale configuration is not authority.
13. Agent/business configuration is owner/admin-only in V1; server authorization remains authoritative.
14. Meaningful configuration changes leave PII/secrets-minimized audit evidence.
15. Business-facing model selection, temperature, raw tool-loop tuning, and equivalent runtime controls are outside V1 scope.
16. Repeated important business instructions should become structured product facts/policies rather than free-form prompts.
