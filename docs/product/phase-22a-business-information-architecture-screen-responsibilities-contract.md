# Phase 22A — Locked Business-side Information Architecture & Screen Responsibilities Contract

Status: LOCKED

This document is an authoritative companion to the Avenlyo V1 Product Blueprint and the other Phase 22A locked contracts. It defines the V1 business-side navigation, the single authoritative responsibility of each major screen, and the boundaries that prevent duplicate operational state machines across the dashboard.

Implementation work must not weaken these rules implicitly.

Runtime deployment, production infrastructure, provider provisioning, production credentials, and production data are out of scope.

## Core information-architecture principle

Avenlyo's business dashboard is organized around how an operator works, not around internal technical modules.

The product mental model is:

```text
observe operations
    ↓
work the queue
    ↓
manage appointments and customers
    ↓
review commercial opportunities and history
    ↓
configure automation and integrations
    ↓
manage the business account
```

Every consequential business action has one authoritative operational surface. Other screens may summarize or link to that object, but they must not implement a competing mutation path.

## Locked V1 top-level navigation

The preferred desktop information architecture is:

```text
AVENLYO

OPERATE
Overview
Inbox
Appointments

CUSTOMERS
Customers
Leads
Conversations

AUTOMATION
AI Front Office
Integrations

MANAGE
Settings
```

The following changes are locked:

- `Needs Attention` is not a top-level business object. It is an Inbox state/filter.
- Billing is not a primary product area. It lives under Settings / account management, although the underlying route may remain for compatibility.
- Home becomes `Overview` and becomes a real operational dashboard rather than an onboarding-complete placeholder.

Role-based navigation may hide configuration areas from users who cannot operate them, but server authorization remains authoritative. Hiding a menu item is never a security boundary.

## Overview — cross-product operational summary

Overview answers four questions quickly:

- What happened?
- What did Avenlyo complete?
- What is still unresolved?
- What requires a human now?

The first viewport should prioritize current operational state rather than generic SaaS analytics.

Representative summary cards:

```text
Needs attention
Today's appointments
New leads
AI-resolved today
```

Below the summary, Overview may show:

- a bounded `Needs your attention` preview;
- today's upcoming appointments;
- recent verified AI activity;
- high-level capability or integration warnings that materially affect today's work.

Overview is a read-oriented aggregation surface. It must not create duplicate implementations of Inbox claim/reply/resolve actions, appointment lifecycle mutations, lead mutations, or integration configuration.

An actionable item links to its authoritative domain surface.

Examples:

```text
attention item -> Inbox / exact conversation
appointment -> Appointments / exact appointment
lead -> Leads / exact lead
customer -> Customers / exact customer
```

## Inbox — authoritative human conversation work queue

Inbox is the single authoritative surface for human conversation work.

Its product definition is:

> Conversations that currently require or are under human operational attention.

Inbox owns conversation-control and handoff operations such as:

- claim;
- authorized human reply;
- release;
- resolve handoff;
- explicit Resume AI;
- manual takeover where permitted.

No other business-side screen may implement a competing version of these ownership transitions.

### Locked Inbox filters

The intended V1 filter model is:

- Needs attention
- Unassigned
- Assigned to me
- Waiting on customer
- All open

Urgency is a queue-priority/badge dimension rather than a second queue implementation. Resolved conversation history belongs in Conversations rather than being a primary Inbox destination.

### Inbox row responsibilities

A row should expose enough information for triage without forcing an operator to open every conversation:

- customer display identity where safely known;
- channel;
- bounded reason for human attention;
- urgency;
- elapsed waiting signal;
- current owner/assignment state;
- relevant linked appointment/lead state when useful and safe.

### Inbox detail responsibilities

The selected conversation should show:

- concise handoff summary;
- customer goal;
- verified/collected facts;
- what the AI already attempted;
- what actually succeeded;
- what remains unresolved;
- full bounded/auditable transcript;
- linked customer, appointment, lead, and provider-operation references where applicable;
- only the operator actions the server would currently authorize.

The summary is derived operational context, not a replacement for authoritative state.

## Appointments — authoritative appointment lifecycle surface

Appointments is the business-side home of verified appointment lifecycle state.

The preferred V1 primary view is calendar-first on desktop and agenda-first on narrow/mobile screens.

The page may provide Today / Week views and relevant filters.

Appointment detail should present, where available:

- customer;
- appointment subject;
- service / appointment type;
- exact date/time and timezone presentation;
- location;
- resource/provider;
- verified appointment status;
- provider synchronization/operation state;
- reminder state;
- source/creator attribution where product-approved;
- related conversation;
- related lead.

Provider-supported lifecycle actions such as reschedule or cancel belong here for authorized business operators, subject to the locked Appointment, Identity, Confirmation, and Provider Operation contracts.

An uncertain provider operation must never be rendered as a false verified lifecycle state. For example, an unknown cancellation result may show a visible verification warning and link to the corresponding Inbox item rather than claiming the appointment is cancelled.

Appointments does not own provider authentication or connection setup; that belongs to Integrations.

Appointments does not own AI behavior configuration; that belongs to AI Front Office.

## Customers — authoritative Customer 360 surface

Customers is the business-side view of durable customer/contact identity and relationship history.

The primary detail experience is a Customer 360 timeline rather than a static CRM form.

The customer header may include:

- display name;
- trusted/masked contact methods as permitted;
- preferred channel where known;
- first-seen and last-activity timing;
- relevant tags or location context where product-approved.

The customer view may summarize:

- upcoming appointments;
- open human work;
- active leads/follow-up state;
- conversation history;
- appointment history;
- reminder events;
- handoff events;
- verified operational outcomes.

The timeline represents one customer story across product domains.

Customers must not become a second Inbox. If human conversation work is active, the customer page links to `Open in Inbox`.

Customer merge, identity transfer, or other high-risk identity mutations remain governed by the locked Identity Contract and are not autonomous AI operations.

## Leads — authoritative commercial opportunity surface

Leads represents commercial/service opportunity, not conversation ownership.

A lead may exist without a human-attention episode and without an immediate booking.

The minimum V1 pipeline is:

```text
NEW
  ↓
QUALIFIED
  ↓
CONVERTED
```

Additional business states such as closed/lost may be introduced only through explicit product design rather than silently inferred from inactivity.

Lead detail may show:

- customer;
- expressed service interest;
- customer goal;
- source channel;
- urgency where genuinely captured/derived by approved policy;
- trusted captured facts;
- source conversation;
- appointment if converted;
- follow-up state.

A lead is not automatically an Inbox item. Human attention is created only when a separate handoff/follow-up policy requires it.

## Conversations — authoritative communication archive

Conversations is history, investigation, audit, and search — not the operational ownership queue.

It is read-oriented and may support filters such as:

- channel;
- date/time range;
- AI vs human handling;
- outcome;
- status;
- appointment relationship;
- lead relationship;
- handoff relationship.

Conversation detail may show:

- full transcript;
- AI/human attribution;
- customer reference;
- linked appointment;
- linked lead;
- handoff history;
- verified outcome metadata.

Conversations must not implement claim, reply, release, resolve, or Resume AI.

If the conversation is currently active human work, the UI links to `Continue in Inbox`.

The locked distinction is:

> Inbox = work.

> Conversations = history.

## AI Front Office — automation control center

AI Front Office owns operator-facing configuration of Avenlyo's customer automation behavior and knowledge surfaces.

The intended V1 sub-areas are:

### Overview

Shows bounded automation status and capability health, for example:

- AI active/paused configuration status;
- enabled channels;
- knowledge readiness/health;
- scheduling capability status;
- handoff capability status.

### Behavior

Contains only product-approved, bounded business controls such as:

- tone/persona options;
- greeting behavior;
- supported service configuration where appropriate;
- business-level handoff preferences where safe.

The business is not given an unrestricted system-prompt editor that can override Avenlyo safety, identity, confirmation, or provider policies.

### Knowledge

Owns the Business Knowledge lifecycle:

```text
import -> review -> publish -> retrieve
```

### Channels

Owns channel-specific customer-experience configuration for Web Chat, SMS, and Voice where the corresponding capability exists.

### Test Agent

Provides a safe simulation environment that cannot silently mutate real customer/provider state.

AI Front Office does not own provider connection credentials or OAuth-style lifecycle; that belongs to Integrations.

## Integrations — external connection and capability health

Integrations answers:

> Which external systems is Avenlyo connected to, and which trusted capabilities are currently available?

Typical integrations include scheduling, communications, practice-management, or future CRM providers.

Each integration should expose a bounded lifecycle such as:

```text
NOT_CONNECTED
  ↓
CONNECTING
  ↓
CONNECTED
  ├──> NEEDS_ATTENTION
  ├──> RECONNECTING
  └──> DISCONNECTED
```

An integration detail/card may show:

- connection status;
- configured account/resource in a safe display form;
- enabled capabilities;
- provider-supported lifecycle capabilities;
- bounded health/sync status;
- manage/reconnect/disconnect actions where authorized.

Integrations does not define how the AI should speak to customers. AI Front Office owns behavior.

Integrations does not own appointment business lifecycle mutations. Appointments owns business-side appointment operations through the capability layer.

## Settings — business, team, account, and billing configuration

Settings owns configuration that is primarily about the business/account rather than day-to-day customer work.

Representative areas:

### Business

- business name;
- address;
- phone;
- website;
- other authoritative organization details.

### Location

- location details;
- IANA timezone;
- business hours;
- location-scoped configuration.

### Team

- members;
- roles;
- permissions;
- ownership/admin controls.

### Notifications

Business-side notification preferences may live here when a later notification/SLA contract is defined.

### Billing

- plan;
- usage;
- payment method;
- invoices;
- subscription lifecycle.

Billing may retain a direct route internally, but it is not a primary V1 top-level product destination.

## Role-aware navigation

The navigation may be simplified according to server-authoritative permissions.

A normal member's primary experience may emphasize:

- Overview;
- Inbox;
- Appointments;
- Customers;
- Leads;
- Conversations.

Owner/admin users may additionally access:

- AI Front Office;
- Integrations;
- Settings and its restricted sub-areas.

Exact permission rules remain server-owned and may be finer-grained than this presentation model.

## Cross-screen relationship model

The dashboard should feel like one operating system rather than disconnected pages.

Related entities should link to one another through canonical relationships.

Examples:

```text
Inbox conversation -> Customer
Inbox conversation -> Appointment
Inbox conversation -> Lead
Customer timeline -> Conversation
Customer timeline -> Appointment
Customer timeline -> Lead
Appointment -> Customer
Appointment -> Conversation
Lead -> Customer
Lead -> Conversation
Lead -> Appointment when converted
```

A cross-link does not transfer mutation ownership to the current screen. The authoritative action still happens in the domain surface defined by this contract.

## Single-authority matrix

| Business object/action | Authoritative business-side surface |
| --- | --- |
| Human conversation work | Inbox |
| Communication history | Conversations |
| Customer identity/history | Customers |
| Appointment lifecycle | Appointments |
| Commercial opportunity | Leads |
| AI behavior / knowledge / channel config | AI Front Office |
| External connection and capability health | Integrations |
| Business / location / team / account / billing config | Settings |
| Cross-product operational summary | Overview |

## No duplicate mutation implementations

The following patterns are explicitly forbidden unless a later product contract changes them:

- Overview implementing its own claim/reply/resolve conversation mutation path;
- Customers implementing an independent human-ownership state machine;
- Conversations implementing reply/claim/resume actions in parallel with Inbox;
- Appointments implementing provider connection setup instead of linking to Integrations;
- Integrations implementing appointment business lifecycle actions as a second appointment UI;
- AI Front Office exposing unrestricted policy/system-prompt override controls;
- a second `Needs Attention` queue separate from Inbox.

## Locked navigation removals / moves

The V1 contract requires:

```text
Needs Attention top-level item -> removed; represented by Inbox state/filter
Billing top-level item -> removed from primary IA; represented under Settings
Home -> renamed/reframed as Overview
```

Compatibility routes may redirect or remain internally during implementation, but the product must present one mental model.

## Responsive behavior

The same information architecture applies across desktop and mobile, but presentation may adapt.

Examples:

- desktop Appointments may be week-calendar first;
- mobile Appointments may be agenda first;
- desktop Inbox may use split-pane list/detail;
- mobile Inbox may use list then dedicated detail screen;
- navigation may collapse to a drawer/tab strategy without changing domain authority.

Responsive design must not expose or remove security-sensitive actions solely based on viewport size.

## Required acceptance scenarios

The implementation and Product Acceptance suite must verify at least:

| Scenario | Required result |
| --- | --- |
| User clicks Needs Attention from a legacy link | Lands in canonical Inbox attention state, not a second queue |
| Overview shows an attention item | Opening it routes to the exact Inbox work item |
| Conversation is active human work | Conversations links to Inbox rather than exposing reply controls |
| Customer has an active conversation | Customers links to canonical Inbox conversation work |
| Appointment provider connection is broken | Appointment surfaces bounded warning and links to Integrations where appropriate |
| Appointment mutation is required | Mutation remains under Appointments / trusted lifecycle path |
| Lead exists with no handoff | It appears in Leads but does not automatically pollute Inbox |
| Owner configures AI behavior | Configuration occurs under AI Front Office and cannot override locked safety policy |
| Member lacks configuration authority | Configuration navigation/actions are unavailable and server authorization rejects direct access |
| Billing needs attention | Account/billing UI is reachable through Settings without becoming a primary operational queue |

## Locked summary

Avenlyo V1 uses one authoritative business-side home for each class of work:

- Overview summarizes;
- Inbox operates human conversation work;
- Appointments operates appointment lifecycle;
- Customers owns customer history;
- Leads owns commercial opportunity;
- Conversations owns communication archive;
- AI Front Office configures automation behavior/knowledge/channels;
- Integrations configures external connectivity/capability health;
- Settings configures the business/account/team/billing layer.

The dashboard may cross-link and summarize freely, but it must not create competing state machines or duplicate consequential mutation paths.
