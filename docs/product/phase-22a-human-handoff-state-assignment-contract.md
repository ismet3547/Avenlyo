# Phase 22A — Locked Human Handoff State Machine & Assignment Contract

Status: LOCKED

This document is an authoritative companion to the Avenlyo V1 Product Blueprint, Action Confirmation Contract, Customer Identity & Disambiguation Contract, and Appointment State Machine / Concurrency / Idempotency Contract.

It defines how V1 represents human attention, handoff lifecycle, conversation control, staff ownership, urgency, queue priority, AI silence, operator recovery, and return-to-AI behavior.

Implementation work must not weaken these rules implicitly.

Runtime deployment, production infrastructure, provider provisioning, production credentials, and production data are out of scope.

## Core separation

Avenlyo treats three state axes as distinct:

| Axis | Meaning | Representative states |
| --- | --- | --- |
| Handoff lifecycle | Whether a specific escalation episode is active or finished | `OPEN`, `ACKNOWLEDGED`, `RESOLVED` |
| Conversation control | Whether customer-facing automation may actively respond | `AI_ACTIVE`, `HUMAN_PAUSED` |
| Assignment | Whether one authorized staff member owns the human work | `UNASSIGNED`, `HUMAN_OWNED` |

These axes must not be collapsed into one overloaded status field.

A resolved handoff may coexist with a human-paused, human-owned conversation. That is a valid state.

The locked rule is:

> Resolve is not Resume AI.

and

> Handoff is not Assignment.

## Human Attention Episode

A Human Attention Episode represents the interval during which the conversation has been deliberately removed from normal AI ownership.

Conceptually:

```text
AI_ACTIVE
    │
    │ handoff or manual takeover
    ↓
HUMAN ATTENTION EPISODE
    │
    ├── claim
    ├── human reply
    ├── release
    ├── resolve handoff
    ├── customer replies again
    │
    ↓
explicit Resume AI
    │
    ↓
AI_ACTIVE
```

The episode has a durable anchor such as `human_attention_started_at` or an equivalent trusted field.

Claim, release, resolve, and human reply remain inside the same episode.

Only an explicit successful Resume AI transition closes the episode and clears the episode anchor.

A later escalation after AI has resumed opens a new episode with a new anchor.

## Handoff creation pauses automation

A successful durable customer handoff does more than create an Inbox item.

Its semantic effect is:

```text
active handoff created or reused
        +
human-attention episode opened or preserved
        +
conversation control = HUMAN_PAUSED
```

Once the handoff creation boundary succeeds, normal AI conversation ownership is no longer allowed to compete with the human episode.

The AI may send the bounded acknowledgement that belongs to the handoff-triggering turn where the channel contract permits it, but it must not continue normal autonomous handling as if no escalation occurred.

## Requesting a human does not assign a human

Creating a handoff must not invent a staff owner.

Initial state is normally:

```text
handoff = OPEN
conversation control = HUMAN_PAUSED
assignment = UNASSIGNED
```

The customer may be told that the conversation was sent to the team.

The system must not claim that a named representative is handling the conversation until an authoritative staff claim/assignment exists.

The language model cannot create or select `assigned_user_id` or any equivalent staff identity.

## One active handoff episode per conversation

A customer conversation may have at most one unresolved active handoff episode at a time.

Repeated escalation signals must reuse the same active episode rather than creating duplicate queue rows.

Examples that must coalesce while the same episode is active:

- replayed tool calls;
- duplicate provider events;
- repeated customer requests for a human;
- multiple handoff-producing signals in one AI turn;
- later inbound messages while the handoff is still active.

After the handoff is resolved and AI is explicitly resumed, a later genuine escalation may create a new handoff episode.

Implementation must enforce this with durable database coordination, not in-memory process state.

## Trusted source identity

The model is not the authority for the tenant, location, conversation, customer, source message, or source call that a handoff belongs to.

Trusted runtime/application state must bind the handoff to its source.

Typical trusted source bindings include:

- SMS/web: trusted inbound message identity;
- voice: trusted call identity;
- appointment/provider uncertainty: durable provider operation / appointment intent context;
- manual takeover: authenticated operator plus trusted conversation identity.

The source binding must remain scoped to the same organization, location, and conversation.

The language model may supply only bounded product-approved handoff arguments such as reason and urgency. It may not choose authorization scope.

## V1 handoff trigger classes

Human attention may be required by any of these product-authoritative trigger classes:

- customer explicitly asks for a human;
- deterministic industry safety policy requires escalation;
- provider mutation outcome is `OUTCOME_UNKNOWN`;
- provider/application result is `handoff_required`;
- requested mutation capability is unsupported or unsafe to automate;
- identity ambiguity cannot be safely resolved;
- appointment target ambiguity cannot be safely resolved;
- urgent lead policy requires human follow-up;
- trusted staff manually takes over the conversation;
- another future product policy explicitly requires human handling.

A handoff does not weaken any other contract.

In particular, a human handoff caused by an unknown appointment-provider outcome does not permit Avenlyo to blindly retry the provider mutation. The Appointment State Machine & Idempotency Contract remains authoritative.

## Urgency model

V1 uses two operational urgency classes:

```text
NORMAL
URGENT
```

Urgency is monotonic within an active handoff episode.

Allowed:

```text
NORMAL -> URGENT
```

Not allowed automatically:

```text
URGENT -> NORMAL
```

A later urgent signal escalates the existing active handoff rather than creating a replacement row.

The original handoff reason must not be silently rewritten merely because urgency escalated.

## Urgency is not a promised SLA

V1 does not invent guaranteed response-time commitments that have not been explicitly configured as product policy.

Urgency means queue priority and operational attention.

`waiting_since` means elapsed customer waiting time inside the current human-attention episode.

Neither field alone authorizes customer-facing claims such as:

- “someone will reply in five minutes”;
- “urgent conversations are answered within two minutes”;
- any other guaranteed service-level promise.

SLA thresholds, breach handling, paging, notifications, and contractual response-time promises require a separate explicit SLA/Notification contract.

## Deterministic queue priority

The default V1 operator attention order is:

```text
1. URGENT + customer waiting
2. URGENT
3. NORMAL + customer waiting
4. NORMAL
5. HUMAN_PAUSED conversations with customer waiting
6. remaining active/recent conversations
```

Inside one priority band, the oldest waiting customer or oldest escalation is handled first before simple recency.

Queue priority is a deterministic application/read-model rule, not a language-model decision.

## Atomic claim

Staff ownership acquisition must be atomic.

If two authorized operators claim the same unassigned handoff concurrently:

```text
Operator A ─┐
            ├── authoritative DB arbitration
Operator B ─┘
               ↓
          exactly one owner
```

The winner becomes the owner.

The loser receives a safe conflict result such as `already_claimed` and refreshes authoritative state.

Last-write-wins ownership is forbidden.

## Claim replay is idempotent

If the same authorized operator repeats a successful claim because of retry, network loss, browser resubmission, or duplicate action delivery, the result must remain logically successful without creating a second ownership transition or duplicate lifecycle audit.

Historical first-acknowledgement timing must not be rewritten by replay.

## Human reply may acquire ownership atomically

An authorized human reply to an unassigned human-paused conversation may acquire ownership as part of the same trusted operation.

The system must not implement this as two independently racing client operations where a reply can be persisted before ownership is established.

The logical boundary is:

```text
validate authorization
        ↓
acquire/confirm ownership
        ↓
persist authorized human reply
```

All of these steps must use the same conversation ownership protocol.

## No reply-over or claim-over

A normal operator may not:

- claim a conversation already owned by another operator;
- reply as if they own a conversation assigned to another operator;
- resolve an active handoff they are not authorized to control.

Owner/admin recovery must remain explicit and auditable rather than silently stealing ownership.

The V1 recovery pattern is:

```text
Release
  ↓
Claim
```

An owner/admin may release abandoned work where policy permits, after which another authorized operator may claim it.

## Release semantics

Release changes ownership, not automation control.

```text
HUMAN_OWNED
    ↓ Release
UNASSIGNED
```

Conversation control remains `HUMAN_PAUSED`.

An active handoff remains active unless separately resolved.

Releasing work must not automatically return the customer to AI.

## Resolve semantics

Resolving an active handoff ends that escalation record's active lifecycle.

```text
OPEN / ACKNOWLEDGED
        ↓ Resolve
RESOLVED
```

It does not automatically change conversation control back to `AI_ACTIVE`.

A resolved handoff may therefore coexist with:

```text
conversation control = HUMAN_PAUSED
assignment = HUMAN_OWNED or UNASSIGNED
```

This is intentional.

Finishing the escalation task and authorizing AI to speak again are separate decisions.

## Resume AI is an explicit control transition

AI may resume only through an explicit authorized Resume AI action.

Minimum preconditions include:

```text
no active handoff
+
authorized operator
+
current conversation ownership/control permits resume
```

A successful resume transitions:

```text
HUMAN_PAUSED -> AI_ACTIVE
```

and closes the current human-attention episode.

Resume AI does not synthesize or send an outbound message.

Automation becomes eligible again on a subsequent inbound customer turn or another explicitly allowed future trigger.

## Resume does not revive stale state

Returning control to AI must not revive stale or invalidated application state.

After Resume AI, all applicable contracts are re-evaluated from trusted state, including:

- customer identity assurance;
- target disambiguation;
- candidate expiry;
- action intent expiry/invalidation;
- appointment version/revision;
- confirmation freshness;
- provider reconciliation state;
- capability availability.

An old appointment intent does not become executable merely because AI control resumed.

## AI silence is enforced at trusted boundaries

Prompt instructions alone are not sufficient to guarantee that AI stops competing with a human.

V1 requires server-side enforcement at at least two boundaries.

### Persistence boundary

Before an AI-generated customer reply is persisted as an outbound message, the application re-checks authoritative conversation ownership/control.

If human ownership/control became authoritative while the model was running, the AI reply is discarded/suppressed rather than persisted.

Human ownership wins even when the model call started first.

### Provider-send boundary

A queued AI outbound message that has not crossed the external provider submission boundary must be re-checked immediately before provider submission.

If a person now owns the conversation, the queued AI delivery is suppressed according to the channel contract.

This prevents delayed queued automation from speaking over a human who took control after the AI output was generated.

## Provider truth is never rewritten by handoff state

A provider submission that has already crossed the external mutation boundary is not retroactively rewritten because a human later claimed the conversation.

States such as:

```text
submitted
sent
delivered
unknown
failed
undelivered
```

remain provider/message truth.

Handoff lifecycle may suppress work before provider submission, but it must not falsify provider history after submission.

## Handoff acknowledgement exception

The conversation may be marked human-paused during the same turn that creates a handoff.

The bounded customer-facing acknowledgement belonging to that handoff-triggering turn may still need to be sent where the channel contract permits it.

Therefore suppression must not infer human ownership from `HUMAN_PAUSED` alone.

A durable unclaimed handoff may be human-paused while its own intended acknowledgement is still allowed.

Actual human ownership is the decisive suppression authority for queued AI messages.

## Customer waiting is episode-bounded

Customer waiting is evaluated only inside the current Human Attention Episode.

The episode anchor is inclusive so the inbound customer turn that triggered escalation can count as waiting.

A customer is waiting when there is an inbound customer message in the current episode that has not been answered by a later human-authored outbound reply in that same episode.

An AI-authored reply does not clear human waiting.

After a human reply, a later customer inbound starts a new waiting interval inside the same episode.

Historical customer turns before the current episode must never inflate the current waiting duration.

## Waiting is derived state

V1 does not maintain a second independent unread/waiting counter as business truth.

`customer_waiting` and `waiting_since` are derived from trusted conversation/message state plus the current human-attention episode anchor.

The database/read model is authoritative.

UI code may mirror the rule for testing/rendering, but it must not become an independent state machine that can drift from the server.

## Channel capability boundaries

### SMS and Web

Authorized human Inbox replies may be supported according to the channel transport and messaging contract.

### Voice

Claiming a voice handoff establishes operational ownership of the escalation.

It does not by itself:

- start browser audio;
- create a softphone session;
- transfer the live call;
- create an SMS;
- send any other customer message.

Any future live-call transfer or browser calling capability requires a separate explicit capability contract.

## Manual takeover is distinct from handoff creation

An authorized staff member may manually take over an AI-active conversation even when no AI/customer handoff row exists.

Conceptually:

```text
AI_ACTIVE
   ↓ manual takeover
HUMAN_PAUSED + HUMAN_OWNED
```

This opens a Human Attention Episode.

The system must not create a fake handoff merely to represent manual staff ownership.

Therefore:

> Every active customer handoff pauses automation, but not every human-controlled conversation requires a handoff row.

## Handoff reason taxonomy

The product should distinguish a bounded categorical reason from any operator-facing summary.

Representative reason codes include:

```text
customer_requested_human
safety_escalation
provider_outcome_unknown
provider_capability_unsupported
identity_ambiguous
appointment_target_ambiguous
urgent_lead
automation_unavailable
other
```

A bounded `reason_summary` may be shown to authorized operators when appropriate.

Audit logs must not copy unbounded customer free text merely to explain a handoff.

This taxonomy is a product contract; exact schema changes may be introduced later without weakening the semantic separation.

## Language-model assignment boundary

The language model may request human help, but it cannot:

- choose a staff account;
- assign a conversation to a staff identity;
- bypass tenant/location authorization;
- claim ownership on behalf of a user;
- override an existing owner;
- resume AI on its own authority.

Assignment and control transitions require authenticated application/database authority.

## Stale UI never overrides server authority

The Inbox UI may display stale state.

A user who sees `UNASSIGNED` may click Claim after another user already acquired ownership.

The server/database result is authoritative.

The stale client must receive a conflict outcome and refresh.

Client state must never overwrite newer durable ownership.

## One ownership serialization protocol

Every mutation that can change active handoff assignment, conversation control, or conversation ownership must follow one consistent per-conversation serialization protocol.

This includes at least:

- handoff claim;
- handoff release;
- handoff resolve where ownership/control is touched;
- manual takeover;
- human reply that acquires ownership;
- Resume AI;
- future equivalent ownership transitions.

Different RPCs must not take the same durable locks in conflicting orders.

Deadlock retry is not the primary correctness mechanism.

The protocol must derive the trusted conversation, acquire the common conversation-level coordination primitive, re-read authoritative state, revalidate authorization, and only then mutate.

## Audit lifecycle

Minimum semantic audit events include:

```text
handoff.created
handoff.escalated
handoff.claimed
handoff.released
handoff.resolved
conversation.human_takeover
conversation.ai_resumed
```

Replayed idempotent operations must not duplicate lifecycle audit events.

Audit metadata must remain bounded and PII-minimized.

Do not log customer phone numbers, message bodies, transcripts, unrestricted free-text reasons, or provider secrets merely because they were involved in a handoff.

## Interaction with the Appointment State Machine contract

Human handoff does not supersede appointment execution safety.

Examples:

- `OUTCOME_UNKNOWN` remains blocked from blind provider retry even when a human takes ownership;
- a stale appointment version remains stale after human review;
- an expired candidate remains expired;
- an invalidated Action Intent remains invalidated;
- an unsupported reschedule capability remains unsupported until a safe provider-specific capability is implemented.

Human intervention may reconcile, inspect, or create a new authorized path. It does not make unsafe old state valid.

## Interaction with identity and confirmation contracts

Human handoff does not automatically prove customer identity or appointment target identity.

If the requested human operation still requires customer verification, authorization, or target disambiguation, the authorized business-side workflow must perform it.

Likewise, a customer saying “yes” during or after a handoff does not bypass identity, target, stale-state, or provider capability gates.

## Required acceptance scenarios

Implementation and staging/product acceptance must cover at least these cases:

| Scenario | Required result |
| --- | --- |
| Same handoff requested twice | One active durable handoff episode |
| Normal episode receives later urgent signal | Same handoff escalates to urgent; no downgrade |
| Two operators claim concurrently | Exactly one owner |
| Same owner replays claim | Idempotent success; no duplicate lifecycle audit |
| Operator B replies over Operator A ownership | Rejected |
| Owner/admin recovers abandoned work | Explicit Release then Claim |
| Human claims while model is still generating | AI result is not persisted over human ownership |
| AI SMS queued, then human ownership acquired | Suppressed before provider submission |
| AI SMS already submitted, then human ownership acquired | Provider/message truth preserved |
| Active handoff is resolved | Conversation remains HUMAN_PAUSED |
| Resume AI attempted while active handoff exists | Rejected |
| Resume AI succeeds | No immediate synthetic outbound; AI eligible on later inbound |
| Human reply clears current wait, then customer writes again | New episode-local `waiting_since` begins |
| Historical customer messages predate current episode | They do not inflate current waiting duration |
| Voice handoff is claimed | Ownership changes; no softphone/SMS side effect |
| Appointment provider result is UNKNOWN and handoff opens | Human sees the episode; blind provider retry remains forbidden |
| Manual staff takeover without a handoff | Human episode opens without fake handoff creation |
| Stale UI tries to overwrite newer ownership | Server conflict result wins |

## Locked V1 rules summary

1. Handoff lifecycle, conversation control, and assignment are separate state axes.
2. Human Attention Episode is the durable interval of human control; only explicit Resume AI closes it.
3. Creating/reusing an active customer handoff pauses normal AI automation.
4. Requesting a human never invents a staff assignee.
5. One unresolved active handoff episode exists per conversation.
6. Handoff scope/source identity comes from trusted runtime state, not the model.
7. Urgency is `NORMAL` or `URGENT` and is monotonic within an episode.
8. Urgency and waiting time are operational signals, not unconfigured SLA promises.
9. Queue priority is deterministic application logic.
10. Staff claim is atomic; concurrent claims produce one owner.
11. Claim replay by the same owner is idempotent.
12. Human reply cannot race outside ownership authority.
13. No claim-over or reply-over another operator's ownership.
14. Release changes ownership only; it does not Resume AI.
15. Resolve ends the handoff lifecycle only; it does not Resume AI.
16. Resume AI is explicit, authorized, and creates no immediate outbound message.
17. Resume AI does not revive stale identity, confirmation, candidate, appointment, or provider state.
18. AI silence is enforced at persistence and provider-send boundaries, not just by prompt text.
19. Provider/message truth already submitted externally is never rewritten by handoff state.
20. Handoff acknowledgement may still send before any person owns the conversation.
21. Customer waiting is bounded to the current Human Attention Episode and is derived from trusted state.
22. Voice handoff ownership is not live-call control.
23. Manual takeover may create human control without creating a fake handoff.
24. The LLM may request human help but cannot assign staff or control ownership transitions.
25. Stale UI never overrides authoritative server ownership.
26. All ownership/control mutations use one consistent per-conversation serialization protocol.
27. Lifecycle audits are idempotent, bounded, and PII-minimized.
28. Human handoff never bypasses identity, confirmation, appointment concurrency, or provider-reconciliation safety rules.
