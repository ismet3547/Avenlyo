# Phase 22A — Onboarding, Activation & Go-Live Readiness Contract

Status: **LOCKED**

This contract defines when an Avenlyo workspace is merely configured, when a location/capability is ready, when customer-facing execution is allowed, and how go-live, pause, degraded operation, billing pauses, and multi-location readiness behave in V1.

## 1. Core distinction

The following are separate product states and MUST NOT be collapsed into one boolean:

1. **Workspace Setup Complete** — the initial business/location foundation has been saved.
2. **Readiness** — authoritative system state proves that a capability can operate safely.
3. **Desired Activation** — an authorized business operator explicitly wants the capability live.
4. **Execution Availability** — the platform can actually execute the capability now.

A saved configuration does not imply readiness. Readiness does not imply activation. Activation intent does not imply current execution availability.

A typical state may therefore be:

```text
Configured: YES
Ready: YES
Desired activation: LIVE
Execution availability: PAUSED_BY_BILLING
```

Configuration intent MUST NOT be deleted merely because execution is temporarily unavailable.

## 2. Initial Workspace Setup

The short onboarding wizard remains focused on foundation setup:

```text
Industry
→ Business
→ Location & business hours
→ Website source
→ Review
→ Workspace Setup Complete
```

Completing this flow MUST NOT activate messaging, voice, AI, integrations, scheduling, or any other customer-facing capability.

The final action should conceptually mean **Finish workspace setup**, not **Go live**.

## 3. Activation Checklist

After workspace setup, the dashboard provides an activation/readiness experience rather than another permanent onboarding wizard.

Before first launch, Overview should surface a checklist such as:

```text
Business foundation          ✓
Trusted business knowledge   ✓
Business services            ○
Scheduling                   ○
Customer channel             ○
Human fallback               ○
Agent test                   ○
Launch review                ○
```

Once live, Overview returns to its operational role. Readiness remains accessible through AI Front Office / status surfaces rather than becoming a permanent top-level onboarding navigation item.

## 4. Readiness is derived, not manually asserted

A user cannot mark a capability `READY` by pressing a generic button.

Readiness MUST be derived from authoritative facts such as:

```text
business configuration
+ location/timezone/hours
+ published knowledge
+ configured services
+ provider/integration state
+ channel routing state
+ human fallback capability
+ test results
+ billing/execution entitlement
= readiness read model
```

The product may render states such as:

- `READY`
- `BLOCKED`
- `DEGRADED`
- `NOT_CONFIGURED`

but the business cannot overwrite these facts manually.

## 5. Location scope

Readiness and activation are location-scoped.

Example:

```text
Istanbul Clinic
Web Chat: LIVE
Voice: LIVE
Scheduling: READY

Ankara Clinic
Web Chat: CONFIGURED
Voice: NOT_CONFIGURED
Scheduling: BLOCKED
```

Organization-level views may aggregate location state but MUST NOT replace per-location authority.

## 6. Business foundation requirements

Before customer-facing launch, a location MUST have trustworthy foundational configuration including:

- a supported V1 industry pack,
- business identity,
- location identity,
- valid IANA timezone,
- usable business hours.

Invalid or missing timezone is a launch blocker because appointment timing, reminders, quiet hours, and customer-facing local time depend on it.

## 7. Trusted knowledge requirement

A customer-facing location MUST have at least one trusted business-knowledge source capable of supporting business-specific answers.

Providing only a website URL is not enough. Imported website material is not launch-ready merely because it was crawled.

Website knowledge must pass the existing review/publish boundary before it counts as trusted launch knowledge.

Structured/manual knowledge may satisfy this requirement later if it has the same authoritative publication/review semantics.

## 8. Business Services activation step

Industry taxonomy is not business service authority.

Activation MUST include an explicit representation of the services the business actually offers.

For example, a veterinary industry pack may know that `vaccination` is a valid domain category, but only business-owned configuration/knowledge may establish that a specific clinic offers vaccination.

Where scheduling is enabled, customer service intent must map through trusted configuration:

```text
Customer service intent
→ configured business service
→ configured appointment type
```

The agent MUST NOT invent service-to-appointment-type mappings.

## 9. Capability-driven scheduling readiness

Scheduling is required only when the location intends to expose AI appointment capabilities.

If booking is enabled, readiness should require at least:

- connected scheduling provider,
- provider verification/health,
- active appointment type,
- active resource/calendar,
- trusted service mapping,
- successful read-only availability/provider preflight,
- timezone consistency.

If no scheduling provider is configured, the whole Front Office need not be blocked. A location may still go live for capabilities such as:

- business information,
- lead capture,
- human handoff.

In that state the product MUST clearly report booking as unavailable, and the agent MUST NOT imply that it can book.

## 10. Full AI Front Office Ready

A stronger readiness label may be used when the main V1 value proposition is fully enabled, including scheduling.

`Full AI Front Office Ready` means the core V1 capabilities expected for the configured location are ready, not merely that some customer channel can respond.

This label MUST NOT be shown if scheduling is intentionally absent or not ready where scheduling is part of the selected product promise.

## 11. Per-channel readiness

Web Chat, SMS, and Voice maintain independent readiness and activation state.

A location may be operationally live if at least one customer channel is live while others remain unconfigured or blocked.

Example:

```text
Web Chat: READY / LIVE
SMS: NOT CONFIGURED
Voice: CONFIGURED / NEEDS VERIFICATION
```

### 11.1 Web Chat

Conceptual lifecycle:

```text
NOT_CONFIGURED
→ CONFIGURED
→ INSTALLATION_PENDING
→ VERIFIED
→ READY
→ LIVE
```

Configured origins or an enabled checkbox alone are not sufficient evidence of successful installation.

Where practical, final verification should prove that the widget can establish a real session/handshake from an approved production origin.

### 11.2 SMS

SMS readiness depends on trusted provider-backed state, including the active business route/DID, inbound routing, outbound delivery capability, location binding, and deterministic opt-out handling.

Typing a phone number into configuration is not sufficient readiness evidence.

### 11.3 Voice

Conceptual lifecycle:

```text
NUMBER_ASSIGNED
→ ROUTE_VERIFIED
→ AI_CONFIGURATION_VALID
→ READY
→ LIVE
```

Human live-transfer capability is optional unless explicitly enabled as part of the location's advertised capability. If live transfer is enabled, its provider/trunk target must be verified before that capability is reported ready.

## 12. Human fallback is a launch blocker

A customer-facing AI Front Office requires a working human fallback.

At minimum:

```text
AI can create human-attention work
→ an authorized location operator can access Inbox
→ work can be claimed/handled/resolved
```

A second team member is not mandatory if the owner/admin can perform the operator role.

No usable human fallback means the customer-facing location is not launch-ready.

## 13. Agent Test as preflight

Agent Test remains internal-only and MUST NOT create real customer activity.

Before launch, it should evolve into a vertical-aware readiness suite that tests representative scenarios.

Examples:

Veterinary:

- business-hours question,
- routine service information,
- unknown-information handling,
- routine appointment request,
- explicit human request,
- possible emergency,
- unsupported clinical question.

Auto Repair substitutes relevant safety scenarios; Medspa substitutes clinical-eligibility/sensitive-information scenarios.

Readiness assertions SHOULD include deterministic product checks where possible, such as:

```text
possible emergency
→ no booking mutation
→ safety escalation path selected
→ no diagnosis/clinical recommendation
```

Test success MUST NOT be decided solely by an LLM declaring its own response successful.

## 14. No live side effects in activation tests

Pre-launch Agent Test MUST NOT create:

- real customer SMS,
- real outbound calls,
- real appointment mutations,
- real marketing follow-ups,
- production analytics outcomes.

Provider connectivity/availability may be tested through safe read-only preflight where supported.

Real provider mutation acceptance belongs to controlled staging/product-acceptance testing, not customer workspace activation.

## 15. Warnings versus blockers

The readiness engine MUST distinguish launch blockers from optional warnings.

Examples of warnings:

- appointment reminders disabled,
- lead follow-up disabled,
- live voice transfer disabled,
- optional secondary channel not configured.

Examples of blockers:

- no usable customer channel,
- no working human fallback,
- invalid timezone,
- no trusted business knowledge,
- booking capability enabled but provider/policy invalid,
- unsafe/incomplete channel routing configuration,
- critical Agent Test failure,
- no execution entitlement for first activation.

The UI must explain why launch is blocked rather than rendering an undifferentiated setup error.

## 16. Explicit Go Live

Passing readiness does not automatically expose customer traffic.

An authorized owner/admin MUST explicitly perform the customer-facing activation action.

Conceptual review:

```text
Ready to go live

Web Chat            READY
SMS                 NOT SELECTED
Voice               READY

Business information  ✓
Lead capture           ✓
Appointments           ✓
Human handoff          ✓

[ Go live ]
```

`Go Live` is an auditable business action.

## 17. Configuration save does not activate

The following actions MUST NOT automatically start customer traffic:

- saving Web Chat origins,
- saving a Voice configuration,
- connecting a calendar/provider,
- importing/publishing knowledge,
- configuring bookable appointment types,
- enabling reminder/follow-up settings.

The lifecycle is:

```text
CONFIGURE
→ VERIFY
→ READY
→ explicit ACTIVATE
→ LIVE
```

This invariant prevents accidental launch.

## 18. Billing and first activation

First `Go Live` requires current execution entitlement.

A billing-paused location must not be first-activated into a future hidden auto-launch state.

If an already-live location later becomes billing-paused:

```text
desired_activation = LIVE
execution = PAUSED_BY_BILLING
```

Configuration and desired activation are retained.

When billing is restored, the platform must revalidate readiness before resuming execution. The UI should clearly state whether the location will resume automatically when billing is restored.

## 19. Degraded operation

A partial capability outage should not unnecessarily disable unrelated Front Office capabilities.

Example:

```text
Web Chat       LIVE
Knowledge      HEALTHY
Lead capture   HEALTHY
Human handoff  HEALTHY
Scheduling     DEGRADED
```

In this state Avenlyo may continue answering grounded business questions, capturing leads, and handing off to humans, while booking fails closed to a safe unavailable/handoff path.

The agent must never fabricate scheduling success merely because the rest of the Front Office remains live.

## 20. Fail-closed channel integrity

Capability outage and trust-boundary failure are different.

A scheduling provider outage may degrade only scheduling.

By contrast, problems involving tenant/channel routing integrity, destination/sender integrity, invalid Web Chat origin trust, or ambiguous Voice routing identity can require the affected channel to become `BLOCKED` or `PAUSED`.

Security/identity/channel-routing integrity failures fail closed.

## 21. Business Pause

Owner/admin needs an explicit `Pause AI Front Office` control.

Conceptual lifecycle:

```text
LIVE
→ PAUSED_BY_BUSINESS
→ READY/RESUME
→ LIVE
```

Pause preserves configuration.

Channel semantics may differ:

- Web Chat: no new autonomous AI sessions while paused.
- SMS: trusted inbound may still be ingested/persisted; deterministic STOP handling remains active; autonomous AI replies are suppressed.
- Voice: autonomous AI answering is disabled; a configured provider fallback may apply.

Resume must re-evaluate readiness rather than blindly restoring execution.

## 22. Post-launch readiness changes

A live location is continuously re-evaluated as authoritative configuration changes.

Non-critical changes may result in:

```text
LIVE → DEGRADED
```

Critical trust/readiness failures may result in:

```text
LIVE → BLOCKED
```

The product must surface required operator action through Overview and the owning configuration surface such as Integrations or AI Front Office.

This does not require a separate top-level `Needs Attention` navigation object.

## 23. Final onboarding/activation journey

```text
Sign up
→ Industry
→ Business
→ Location & hours
→ Website source
→ Review
→ Workspace Setup Complete
→ Dashboard Activation Checklist
→ Trusted Knowledge
→ Business Services
→ Scheduling (when used)
→ Customer Channels
→ Human Fallback
→ Agent Test
→ Launch Review
→ GO LIVE
```

The initial wizard stays short, while customer-facing launch remains a deliberate, evidence-backed action.

## 24. Locked invariants

The following are authoritative V1 product rules:

1. Workspace Setup Complete, Ready, Desired Activation, and Execution Availability are different concepts.
2. Readiness is location/capability scoped and derived from authoritative state; users cannot manually mark a capability ready.
3. Customer-facing activation requires explicit owner/admin `Go Live`; onboarding completion or configuration save never activates customer traffic.
4. At least one ready customer channel, trusted business knowledge, and a working human fallback are required for customer-facing launch.
5. Scheduling is a blocker only when appointment capability is intended to be active; without scheduling, Avenlyo may run in a clearly limited capability mode.
6. `Full AI Front Office Ready` requires the principal V1 promise, including scheduling where applicable.
7. Web Chat, SMS, and Voice maintain separate readiness/activation state.
8. Agent Test is a vertical-aware deterministic preflight and creates no real customer/provider mutation side effects.
9. Warnings and blockers are separate classes.
10. Configuration, activation intent, and current execution availability remain distinct; billing/integration outages do not erase business configuration.
11. Partial provider failure degrades only the affected capability where safe; security/identity/channel-routing failures fail closed.
12. First Go Live requires active execution entitlement; later billing pause preserves configuration/live intent and resumes only after readiness revalidation.
13. Owner/admin can pause the AI Front Office without deleting configuration; resume revalidates readiness.
14. Readiness and activation are location-scoped in multi-location organizations.
15. Pre-live Overview hosts the Activation Checklist; once live it returns to normal operational Overview rather than retaining a permanent onboarding wizard.
