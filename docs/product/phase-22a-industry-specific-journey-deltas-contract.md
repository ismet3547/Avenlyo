# Phase 22A — Locked Industry-specific Journey Deltas Contract

Status: LOCKED

This document is an authoritative companion to the Avenlyo V1 Product Blueprint and the other locked Phase 22A contracts. It defines how Veterinary, Auto Repair, and Medspa/Aesthetics differ while remaining implementations of one Avenlyo Front Office core.

Implementation work must not weaken these rules implicitly.

Runtime deployment, production infrastructure, provider provisioning, production credentials, and production data are out of scope.

## Core architecture

Avenlyo V1 uses one core product model with declarative industry policy packs.

```text
                 Avenlyo Core
                      ↓
       ┌──────────────┼──────────────┐
       ↓              ↓              ↓
 Veterinary       Auto Repair       Medspa
 Policy Pack      Policy Pack      Policy Pack
```

The core owns the invariant product contracts:

- intent precedence;
- customer identity and authorization;
- action confirmation;
- appointment concurrency, idempotency, and provider truth;
- human handoff and conversation ownership;
- channel behavior;
- tool/capability authority;
- business-side information architecture.

Industry policy may add domain-specific vocabulary, subject semantics, qualification, sensitive-field constraints, safety escalation, and service/appointment mappings. It may not weaken the core contracts.

The locked rule is:

> Industry policy may specialize or tighten Avenlyo Core, but may not bypass it.

## Customer and Appointment Subject are separate concepts

The V1 product model distinguishes the person/contact interacting with the business from the subject receiving the service.

| Industry | Customer | Appointment Subject |
| --- | --- | --- |
| Veterinary | Pet owner/client | Pet |
| Auto Repair | Vehicle owner/customer | Vehicle |
| Medspa / Aesthetics | Client | Normally the client themself |

This distinction is product-authoritative.

A subject is not identity proof. A pet name, vehicle description, or treatment interest may help disambiguate an appointment but may not establish customer authorization.

Examples:

```text
Sarah
 ├─ Bella
 └─ Luna
```

and

```text
John
 ├─ 2020 BMW 320i
 └─ 2018 Ford Transit
```

The statement `cancel Bella's appointment` uses `Bella` to identify the target appointment after customer identity is sufficient; it does not prove who the customer is.

## Core subject model direction

The product direction supports a reusable appointment-subject concept instead of creating three incompatible scheduling systems.

Conceptually:

```text
Customer
   ↓
Subject
   ↓
Appointment
```

The exact storage representation may vary during implementation, but route- or UI-specific assumptions that `customer_id` always fully describes the service subject are not authoritative.

## Service taxonomy is not business availability

An industry pack's service categories are a normalization vocabulary, not proof that a specific business offers those services.

For example, the Veterinary taxonomy may contain `grooming`, and the Medspa taxonomy may contain `injectables_interest`, while a particular business may offer neither.

The locked separation is:

```text
Industry taxonomy
      ≠
Business service availability
```

Business-specific service availability comes only from trusted business configuration and/or approved business knowledge.

The agent must never infer that a service is offered merely because the industry pack recognizes the category.

## Service interest and appointment type are separate

Customer-facing service interest and provider-bookable appointment types are different concepts.

Example:

```text
customer intent: vaccination
        ↓
trusted/configured mapping
        ↓
provider appointment type: consultation / vaccination visit / other configured type
```

The agent must not invent this mapping.

The same rule applies to Auto Repair and Medspa.

If the required mapping does not exist or is ambiguous, the agent must clarify, use trusted business configuration/knowledge, or hand off according to policy rather than guessing.

## Minimum-information principle

Industry-specific qualification must collect only what the next trusted step genuinely needs.

The product must not interrogate customers merely to fill a CRM record.

The locked rule is:

> Ask only what the next safe and useful trusted step requires.

Information already supplied by the customer may be reused within the applicable conversation/identity policy; it need not be re-asked without reason.

---

# Veterinary Policy Delta

## Product role

The Veterinary agent is a veterinary front-office assistant, not a clinician.

It may handle administrative and business-facing tasks such as:

- opening hours and location questions;
- published service information;
- published pricing or policy information when grounded;
- new-client administrative information;
- generic appointment availability;
- appointment booking;
- existing appointment lookup/lifecycle where identity and provider rules permit;
- pet name/species capture when the customer volunteers them or the workflow requires them;
- lead capture;
- human handoff.

## Clinical boundary

The Veterinary agent must not:

- diagnose;
- recommend medication;
- recommend dosage;
- recommend treatment;
- determine clinical severity as a substitute for escalation policy;
- promise that waiting is safe;
- give emergency clinical instructions beyond product-approved administrative/safety wording.

Potential emergency descriptions are handled as a safety interrupt, not ordinary scheduling context.

Representative trigger classes include, but are not limited to, product-approved signals such as:

- difficulty breathing;
- seizure;
- collapse;
- severe bleeding;
- possible poisoning;
- inability to urinate;
- major trauma.

A safety trigger suspends ordinary booking/lead progression and invokes the Human Handoff Contract.

The locked distinction is:

> Safety escalation is not diagnosis.

## Veterinary subject

The appointment subject is the pet.

The minimum V1 product representation is intentionally small:

```text
Pet
- display name
- species, when supplied or genuinely required
```

The product must not require breed, sex, date of birth, weight, medical history, or other clinical data merely for generic lead capture or booking unless a specific trusted provider/business workflow requires structured collection and that collection is separately approved.

## Veterinary lead qualification

Representative domain categories include:

- wellness;
- vaccination;
- sick visit;
- grooming;
- other.

These categories normalize expressed interest. They do not prove the clinic offers the service.

`pet_name` and `species` are low-risk administrative facts when explicitly stated by the customer. They remain subject to the general rule not to invent values.

## Veterinary booking

A veterinary customer may have multiple pets.

Therefore appointment lookup, cancellation, and reschedule flows may use pet name as target disambiguation only after customer identity is sufficient.

Example:

```text
Customer identity sufficient
        ↓
Two future appointments
        ↓
Bella vs Luna used to disambiguate
        ↓
Exact appointment target
        ↓
prepare / confirmation / commit
```

A pet name alone must never reveal another customer's records.

## Veterinary human-handoff summary

A bounded operator summary may include:

```text
Customer goal: Appointment
Pet: Bella
Customer stated: Difficulty breathing
AI action: No clinical advice given; normal booking suspended
Reason: Possible animal emergency policy
```

The summary must distinguish customer-stated facts from system/provider-verified facts.

---

# Auto Repair Policy Delta

## Product role

The Auto Repair agent is an automotive front-office assistant, not a mechanic or vehicle-safety authority.

It may handle administrative/business tasks such as:

- opening hours and location;
- published service information;
- estimate-process explanation;
- maintenance/repair/inspection/diagnostic service interest capture;
- generic availability;
- service-visit booking;
- appointment lookup/lifecycle where permitted;
- vehicle make/model/year capture when supplied or genuinely required;
- lead capture;
- human handoff.

## Mechanical and safety boundary

The Auto Repair agent must not:

- diagnose a mechanical problem as fact;
- assure a customer that a vehicle is safe to drive;
- minimize a safety-critical symptom;
- recommend driving a potentially unsafe vehicle to the shop;
- present speculative mechanical causes as verified diagnosis.

Safety-critical descriptions such as brake or steering concerns are treated as a safety interrupt according to product-approved policy.

The locked distinction is:

> Administrative capture of a symptom is allowed; mechanical diagnosis or safe-to-drive assurance is not.

## Auto Repair subject

The appointment subject is the vehicle.

The preferred minimum V1 representation is:

```text
Vehicle
- make, when supplied/required
- model, when supplied/required
- year, when supplied/required
```

VIN and license plate are not default AI qualification fields. If a future provider workflow needs them, they should be collected through an explicit structured workflow and separate privacy/identity review rather than by expanding free-form model collection casually.

## Auto Repair lead semantics

Representative domain categories include:

- maintenance;
- repair;
- inspection;
- diagnostic;
- other.

Customer goal remains a separate normalized dimension, for example:

- appointment;
- estimate;
- information;
- service.

Example:

```text
Customer: "BMW 320i için fren değişimi ne kadar?"
service category = repair
customer goal = estimate
```

The system must not treat estimate interest as implicit consent to book an appointment.

## Auto Repair safety interrupt

Example:

```text
"Direksiyon bazen kilitleniyor ama yarın randevu istiyorum."
```

The normal task may be `APPOINTMENT_BOOK`, but the vehicle-safety interrupt takes precedence. Ordinary booking must not continue as if the safety statement were merely another service detail.

The AI must not advise the customer that driving is safe.

## Auto Repair human-handoff summary

A bounded operator summary may include:

```text
Vehicle: 2020 BMW 320i
Customer stated: Steering intermittently locks
AI action: No safety assurance given
Reason: Vehicle safety escalation
```

---

# Medspa / Aesthetics Policy Delta

## Product role

The Medspa agent is a front-office assistant for administrative treatment inquiries and appointment scheduling, not a clinician.

It may handle:

- published treatment/service descriptions;
- published pricing;
- opening hours/location;
- administrative policies;
- generic consultation/appointment availability;
- treatment-interest lead capture;
- consultation booking;
- existing appointment lifecycle where permitted;
- approved administrative preparation information when it comes from published trusted business knowledge;
- human handoff.

## Clinical boundary

The Medspa agent must not:

- diagnose;
- determine contraindications;
- determine medical eligibility;
- recommend a medical treatment as personalized clinical advice;
- advise that a procedure is safe for a particular medical condition;
- perform medical-history intake merely for lead qualification;
- infer contraindications from customer statements as a substitute for clinical review.

Clinical eligibility and contraindication questions trigger human escalation according to product-approved policy.

## Medspa subject

In V1 the appointment subject is normally the customer themself.

A separate subject directory is therefore not required by default for Medspa. The core subject abstraction still applies so the scheduling model remains consistent across industries and future scenarios.

## Medspa lead qualification is not clinical intake

Medspa lead qualification is commercial/front-office qualification.

Safe representative facts may include:

```text
interest = laser_or_energy
customer goal = information
preferred timing = afternoon
```

The AI must not proactively collect fields such as:

- medical history;
- diagnoses;
- medications;
- pregnancy status;
- contraindications;
- other clinical eligibility data;

unless a future explicitly approved workflow introduces a structured clinical boundary outside ordinary AI lead qualification.

The current industry policy's sensitive-field vocabulary is a restriction signal, not permission for the model to gather those values.

## Treatment interest is not a recommendation

Example:

```text
Customer: "Botox mu filler mı daha iyi?"
```

The agent may provide grounded, general published information describing both offerings where available, but it must not decide which treatment is medically appropriate for that customer.

A safe product response may redirect the clinical decision to a consultation while still moving the administrative task forward.

## Medspa human-handoff summary

A bounded operator summary may include:

```text
Interest: Injectables
Customer asked: Whether treatment is safe with a stated condition
AI action: No eligibility determination made
Reason: Clinical eligibility requires staff review
```

---

# Terminology Layer

Industry-aware presentation may rename core concepts without changing core authority or persistence semantics.

| Core concept | Veterinary | Auto Repair | Medspa |
| --- | --- | --- | --- |
| Customer | Pet owner / client | Customer | Client |
| Subject | Pet | Vehicle | Client/self |
| Appointment | Appointment | Service visit | Appointment / consultation |
| Service interest | Care/service interest | Repair/service interest | Treatment interest |
| Safety escalation | Possible animal emergency | Vehicle safety concern | Clinical eligibility/contraindication concern |

UI vocabulary may be industry-aware, while APIs/services continue to use normalized core concepts where practical.

The product must not create three mutually incompatible data models solely to achieve different labels.

# Industry Pack is a Domain Policy, not just a Prompt

The long-term product direction treats `IndustryPack` as declarative domain policy.

Conceptually it may grow to describe:

```text
IndustryPack
├─ terminology
├─ subject semantics
├─ service taxonomy
├─ lead qualification policy
├─ sensitive-field policy
├─ safety policy
├─ appointment/service mapping policy
├─ handoff policy
├─ customer-facing defaults
└─ dashboard vocabulary
```

Not every field must be implemented immediately. The architectural rule is that domain variation belongs in a source-controlled declarative boundary rather than being spread as ad hoc `if industry === ...` logic across routes, transport adapters, UI components, and persistence code.

# Policy layering

The authoritative policy order is:

```text
Avenlyo Core Safety and Product Contracts
                 ↓
Industry Policy Pack
                 ↓
Business Configuration
                 ↓
Published Business Knowledge
                 ↓
Customer Input / Model Inference
```

Lower layers may not weaken higher layers.

Examples:

- a business cannot configure a Veterinary agent to give diagnoses;
- a Medspa business cannot enable autonomous contraindication decisions;
- an Auto Repair business cannot configure safe-to-drive assurances;
- website text cannot override identity or confirmation policy;
- customer instructions cannot create new tool authority.

# Commercial urgency vs safety escalation

These remain separate concepts.

Commercial urgency expresses how soon the customer wants service or how operationally important a lead is.

Safety escalation is a deterministic product-policy interrupt triggered by a safety/clinical class of concern.

Examples:

```text
"I need an oil change today" -> commercial urgency
"My steering locks while driving" -> vehicle safety escalation
```

and

```text
"Can I get a vaccine appointment today?" -> commercial urgency
"My pet is having trouble breathing" -> veterinary safety escalation
```

An `URGENT` lead label must not be used as a medical or safety diagnosis.

# Qualification validation

Industry qualification is declarative and source-controlled.

The model may extract only customer-stated facts and only approved detail fields. The application validates/normalizes those facts against the active pack.

Urgent lead handoff remains a source-controlled industry policy rather than a model-provided authorization flag.

Missing qualification fields result in `needs_more_information` only when those fields are genuinely required by the pack/workflow.

Sensitive-field policy must prevent the model from treating high-risk information as ordinary lead completeness data.

# Human Handoff summaries are industry-aware but authority-aware

Handoff summaries may use industry terminology to reduce operator effort, but they must preserve source truth.

A summary should differentiate:

- customer-stated facts;
- trusted business configuration;
- provider/tool-verified facts;
- AI action already taken;
- action explicitly not taken;
- reason for human attention.

The summary is derived operational context, not a new authority source.

# Dashboard presentation

Customer 360 and related product surfaces may show industry-aware subject sections.

Representative V1 behavior:

```text
Veterinary customer
Pets
- Bella
- Luna
```

```text
Auto Repair customer
Vehicles
- 2020 BMW 320i
- 2018 Ford Transit
```

Medspa normally does not need a separate subject list in V1.

This presentation difference must not weaken the shared Customer Identity or Appointment contracts.

# Industry acceptance matrix

Each launch vertical requires realistic end-to-end acceptance scenarios.

Representative minimum coverage:

| Veterinary | Auto Repair | Medspa |
| --- | --- | --- |
| routine vaccination inquiry | maintenance inquiry | published treatment/pricing inquiry |
| new appointment | service visit | consultation booking |
| two-pet ambiguity | two-vehicle ambiguity | existing appointment lookup |
| possible emergency | brake/steering safety concern | contraindication/eligibility question |
| medication/dosage request | safe-to-drive question | personalized treatment recommendation request |
| pet-specific reschedule | vehicle-specific reschedule | consultation reschedule |
| requested service not offered | requested service not offered | requested treatment not offered |
| urgent commercial lead | urgent commercial service request | urgent commercial treatment interest |

For each scenario the acceptance suite must verify, as applicable:

- correct intent/interrupt precedence;
- no invented business facts;
- correct subject handling;
- correct identity boundary;
- correct safety boundary;
- correct capability/tool selection;
- correct confirmation behavior;
- correct provider outcome handling;
- correct handoff behavior;
- correct durable business outcome.

# Locked invariants

The following are authoritative for V1:

1. Customer and Appointment Subject are separate core concepts.
2. Veterinary subject = Pet.
3. Auto Repair subject = Vehicle.
4. Medspa V1 subject is normally the customer/client themself.
5. Industry service categories normalize domain interest; they do not prove business service availability.
6. Service-interest to appointment-type mapping must come from trusted configuration/mapping, never model inference.
7. Veterinary AI is not a clinician; emergency policy suspends ordinary workflow and escalates.
8. Auto Repair AI is not a mechanic/safety authority and may not provide safe-to-drive assurance.
9. Medspa qualification is not clinical intake and may not autonomously determine contraindications or clinical eligibility.
10. Safety escalation and commercial urgency are separate concepts.
11. Industry policy may not weaken Avenlyo Core safety, identity, confirmation, appointment, handoff, or provider-truth contracts.
12. Industry variation belongs in source-controlled declarative policy rather than scattered transport/service conditionals.
13. Business-specific service availability comes from trusted business configuration/knowledge, not the industry pack alone.
14. Qualification collects only customer-stated, approved facts necessary for the next trusted step.
15. Sensitive-field vocabulary represents a restriction boundary, not permission to collect those fields casually.

Any implementation that silently weakens these invariants requires an explicit product-contract revision before release.
