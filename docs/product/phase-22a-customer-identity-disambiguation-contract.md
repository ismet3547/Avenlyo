# Phase 22A — Locked Customer Identity & Disambiguation Contract

Status: LOCKED

This document is an authoritative companion to the Avenlyo V1 Product Blueprint. It defines how Avenlyo may establish, reuse, disambiguate, and authorize customer identity for V1 customer-facing operations. Implementation work must not weaken these rules implicitly.

Runtime, staging, deployment, production credentials, production infrastructure, and production data are out of scope.

## Core separation

Identity, authorization, and target disambiguation are separate gates.

```text
identity sufficient
  ↓
authorization sufficient
  ↓
target unambiguous
  ↓
action policy / provider capability
  ↓
required confirmation
  ↓
trusted commit
```

Customer confirmation never substitutes for identity, authorization, or target resolution.

## Identity authority

The language model is never the authoritative identity resolver.

The model may understand identity-related facts stated by the customer, but trusted matching, authorization, channel binding, verification, and persistence belong to application/database/provider layers.

Model confidence, fuzzy similarity, or conversational plausibility must never grant access to customer history or mutating actions.

## Deterministic identity assurance states

V1 uses deterministic assurance states rather than probabilistic model confidence:

- `ANONYMOUS` — no established customer identity.
- `CLAIMED` — the customer supplied an identity claim that has not been verified.
- `CHANNEL_BOUND` — trusted transport metadata binds the conversation to a channel address, such as an inbound SMS number or routed phone call.
- `VERIFIED` — a product-approved verification mechanism established stronger identity assurance.
- `HUMAN_VERIFIED` — an authorized business operator established identity through the business-side workflow.
- `AMBIGUOUS` — multiple plausible trusted matches or conflicting trusted identity facts prevent safe resolution.

A statement such as “I am Ayşe Yılmaz” is `CLAIMED`, not verified identity.

## Contact-match states

Matching against trusted identifiers produces one of these product states:

- `NO_MATCH`
- `SINGLE_MATCH`
- `MULTIPLE_MATCH`
- `CONFLICT`

`MULTIPLE_MATCH` and `CONFLICT` fail closed. The AI must not silently choose, merge, or overwrite a customer record.

## Names and descriptive fields are not identity proof

Names, pet names, vehicle details, appointment types, or other descriptive fields may help disambiguate an already authorized scope, but they are not identity proof.

Fuzzy name matching may support business-side search. It must never grant customer authorization or trigger an automatic merge.

## Trusted identifiers

An exact normalized identifier received from a trusted channel may be used as a scoped identity candidate.

Examples:

- a phone number supplied by the inbound SMS provider;
- a caller channel identity supplied by the trusted telephony bootstrap;
- a verified email/phone value supplied by an application verification flow.

A phone number or email typed into chat text is only a customer claim until the application establishes trust for it.

## Channel-specific identity policy

### Web chat

A new web-chat visitor begins as `ANONYMOUS`.

Anonymous users may access public business information, published services/policies, and generic appointment availability when the capability permits it.

Existing-customer history, appointment lookup, reschedule, and cancellation require stronger identity assurance. If the approved verification path is not available, Avenlyo must hand off rather than weaken the identity gate.

Final booking must establish a trusted contactable customer identity through a structured application flow rather than allowing the language model to create authoritative identity directly from free-form text.

### SMS

A trusted inbound SMS number may establish `CHANNEL_BOUND` assurance.

If the normalized trusted number has exactly one valid match within the authorized business/location scope, the matching customer context may be used subject to the action-specific authorization and target-disambiguation rules.

A phone number may be shared by a family or business. `CHANNEL_BOUND` does not remove the need to resolve the exact appointment/subject for consequential actions.

### Voice

Trusted telephony bootstrap may supply a channel-bound customer/contact context. Caller ID alone is not treated as universally verified identity.

Appointment lifecycle actions require the exact authorized appointment target for the active call. Multiple possible appointments must be disambiguated before preparation or commit.

## Minimum identity by action class

| Action | Minimum V1 identity rule |
| --- | --- |
| Public business hours/address/services | `ANONYMOUS` allowed |
| Published pricing/policies | `ANONYMOUS` allowed |
| Generic availability search | `ANONYMOUS` allowed |
| Lead capture | `ANONYMOUS` or `CLAIMED` may be sufficient for an internal lead record; do not infer identity |
| Final new-booking commit | trusted contactable identity established by the application/channel policy |
| Existing appointment lookup | sufficient existing-customer identity within the authorized scope |
| Reschedule | sufficient identity + exact appointment target |
| Cancellation | sufficient identity + exact appointment target |
| Customer history | business-side authorized user or verified customer context as explicitly supported |
| Customer identity/profile ownership changes | not autonomous AI action in V1 |

Identity should be raised only when the requested operation requires it. Public questions must not be blocked behind unnecessary verification.

## New customer creation and duplicate prevention

Locked V1 matching behavior:

```text
trusted normalized identifier
  ↓
0 exact matches → create a new candidate/contact through trusted application logic
1 exact match   → reuse the existing contact
>1 exact matches → AMBIGUOUS; no automatic merge
```

The AI must not merge customer records based on fuzzy name, conversational context, pet/vehicle details, or model confidence.

Customer merge is a separate business-side high-risk data operation.

## Cross-tenant and location scope

Identity matching never crosses organization/tenant boundaries.

All customer-history and appointment access remains scoped by the trusted organization/location context supplied outside the model.

Cross-location automatic customer merging is not part of V1 unless a later contract explicitly defines authorization, ownership, and conflict rules.

## Appointment target disambiguation

Knowing the customer does not identify the appointment.

If more than one appointment may satisfy the request, Avenlyo must resolve one exact target before preparing a reschedule or cancellation.

Safe disambiguation details may include, where appropriate and already authorized:

- appointment date/time;
- appointment type;
- location;
- pet/subject name;
- vehicle description;
- other non-sensitive customer-visible appointment details.

Disambiguation must not disclose unrelated records to an insufficiently identified user.

## Appointment subject is distinct from customer identity

The customer is not always the subject of the appointment.

Examples:

- Veterinary: customer = pet owner; appointment subject = pet.
- Auto Repair: customer = vehicle owner/contact; appointment subject = vehicle.
- Medspa: customer and subject are commonly the same person, but the product model must not assume this globally.

A subject name such as “Bella” is target-disambiguation context, not customer identity.

The product/domain model must preserve this distinction even if the first V1 database representation is simpler.

## Structured identity capture

When an anonymous web visitor needs to establish a contactable identity for booking, Avenlyo should transition to a trusted structured application flow.

```text
AI discovers booking intent
  ↓
structured identity/contact UI
  ↓
trusted validation + normalization
  ↓
match/create decision
  ↓
identity context returned to scheduling flow
```

The LLM must not become the authoritative writer of customer identity from arbitrary free-form chat text.

## Sensitive data minimization

Avenlyo must not collect sensitive information merely to simplify identity verification.

Avoid requesting medical history, payment details, government identifiers, or similarly sensitive data unless a future explicit product requirement and security contract authorizes it.

Verification should use the minimum data necessary for the supported action.

## PII disclosure and enumeration resistance

Avenlyo must not reveal stored PII as a verification hint unless a product-approved masked disclosure is specifically required.

Unauthenticated/insufficiently identified users must not be able to determine whether a named person, phone number, email, appointment, pet, or vehicle exists in the system by observing different success/failure wording.

Responses should collapse to a safe verification-required shape when existence itself is not authorized information.

## Conversation-bound continuity

Once identity is established through a trusted path, that context may be reused within the same valid conversation/session so the customer is not forced to re-verify every turn.

Identity must be re-evaluated or invalidated when trust-relevant context changes, including:

- the customer says they are acting for another person;
- the channel/trusted transport identity changes;
- trusted identity facts conflict;
- the session crosses a defined trust boundary;
- an authorized human changes the customer association;
- policy requires fresh verification for a higher-risk action.

## Identity/profile mutation boundary

Requests such as transferring an account to another person, merging contacts, changing ownership, or reassigning identity history are not autonomous AI actions in V1.

The safe path is business-side handling/handoff under an explicit identity-management workflow.

## Interaction with the Action Confirmation Contract

Identity and confirmation remain independent.

For an appointment mutation the minimum gate is:

```text
trusted channel / verification
  ↓
customer identity resolved
  ↓
authorized scope
  ↓
exact appointment target resolved
  ↓
provider capability / product policy
  ↓
prepare mutation
  ↓
exact current confirmation
  ↓
commit
  ↓
trusted success verification
```

A customer saying “yes” cannot repair an ambiguous identity or ambiguous target.

## Locked V1 rules summary

1. The LLM is never the authoritative identity resolver.
2. Identity, authorization, and target disambiguation are separate gates.
3. Identity assurance uses deterministic states, not model confidence.
4. Names, pets, vehicles, and fuzzy matching do not grant authorization.
5. Trusted normalized channel identifiers create scoped candidates, not universal identity proof.
6. Web, SMS, and voice use channel-appropriate assurance rules.
7. Public information and generic availability remain usable without unnecessary identity friction.
8. Existing-appointment mutations require stronger identity plus an exact target.
9. Multiple matches and conflicts fail closed.
10. AI may not autonomously merge customers or transfer identity ownership.
11. Matching never crosses tenant boundaries; cross-location auto-merge is outside V1.
12. Identity verification minimizes sensitive-data collection.
13. Customer and appointment subject are separate product concepts.
14. PII and customer-existence enumeration must be resisted.
15. Confirmation cannot substitute for identity or target resolution.
