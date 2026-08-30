# Phase 22A — Locked Web Chat / SMS / Voice Channel Behavior Contract

Status: LOCKED

This document is an authoritative companion to the Avenlyo V1 Product Blueprint and the other locked Phase 22A product contracts. It defines how the same Avenlyo Front Office semantics are presented and transported across Web Chat, SMS, and Voice without weakening identity, confirmation, appointment, handoff, or provider-truth rules.

Implementation work must not weaken these rules implicitly.

Runtime deployment, production infrastructure, provider provisioning, production credentials, and production data are out of scope.

## Core channel principle

Avenlyo uses one product brain and three channel adapters.

```text
                 ┌─ Web Chat adapter
Front Office Core├─ SMS adapter
                 └─ Voice realtime adapter
```

The following semantics are shared across every channel:

- intent and interrupt policy;
- identity and authorization policy;
- appointment state and provider-truth policy;
- action confirmation policy;
- handoff and human-control policy;
- capability/tool authority;
- unknown-outcome and idempotency behavior;
- product safety and industry policy.

A channel may change presentation, transport identity, timing, or interaction rhythm. A channel may not weaken product safety.

## Shared invariant — channel context is not customer identity

A valid Web session, SMS sender, or Voice caller context may be useful transport evidence, but it is not automatically equivalent to a fully verified customer identity.

Examples:

- Web chat session token proves authorization to that web conversation, not that the visitor is a specific customer.
- An inbound SMS from a normalized phone number establishes a channel-bound identity candidate, not indisputable proof of the human holding the phone.
- Caller ID establishes a channel-bound candidate and trusted call context, not universal authorization to every customer record.

Identity assurance and action authorization remain governed by the locked Customer Identity & Disambiguation Contract.

## Shared invariant — every inbound transport event has replay identity

Each channel must bind inbound customer activity to a trusted replay identity wherever the transport supports one.

Representative identities:

- Web Chat: `clientMessageId` plus trusted session/conversation context;
- SMS: provider message identifier such as Twilio `MessageSid`;
- Voice: trusted call identity plus final caller transcript/event identity.

Replay of the same transport event must not create duplicate customer messages, duplicate confirmations, duplicate leads, or duplicate external mutations.

## Shared invariant — confirmation does not automatically cross channels

A pending mutating intent prepared on one channel does not become executable merely because another channel receives a generic confirmation such as `yes`.

When the channel changes, Avenlyo must:

```text
resolve current trusted identity
    ↓
load current durable action state
    ↓
revalidate target/version/candidate/provider state
    ↓
re-present or restate the exact action on the new channel
    ↓
obtain fresh confirmation on that channel
```

A channel switch never bypasses the locked Confirmation, Identity, Appointment, or Handoff contracts.

## Shared invariant — provider truth survives channel loss

Closing a browser, losing an SMS response, disconnecting a call, or failing to generate final AI prose does not undo a provider mutation that already succeeded.

Conversely, a dropped channel is never implicit confirmation for a mutation that had not yet been committed.

## Shared disclosure rule

Avenlyo must not impersonate a human employee.

Disclosure style may differ by channel:

- Voice uses an explicit spoken AI Front Office disclosure at the beginning of the call.
- Web Chat identifies the experience as the business's AI Front Office in the widget/header experience.
- SMS uses product-approved automation identity language at the beginning or appropriate first automated turn.

The disclosure does not need to be repeated in every message once established.

## Web Chat — product role

Web Chat is Avenlyo's richest self-service channel.

It supports:

- anonymous public business questions;
- structured appointment discovery;
- structured identity collection where required;
- explicit confirmation controls;
- human takeover inside the same visible chat experience;
- relationship links to appointment/customer outcomes where product-approved.

Web Chat should use structured UI to reduce language ambiguity instead of forcing every decision through free-form text.

## Web Chat session authority

The public chat token is an opaque conversation/session credential. It is never a Supabase credential and never customer-identity proof.

A new Web visitor begins as `ANONYMOUS` unless stronger trusted identity has separately been established.

Anonymous Web visitors may access low-risk capabilities such as:

- published business information;
- configured business hours/address;
- generic service information;
- generic live availability where policy allows;
- starting a new lead or new-booking flow without exposing existing-customer private records.

Existing appointment lookup/change requires the higher identity assurance defined in the Identity Contract.

## Web Chat structured selection

When the server has produced trusted appointment candidates, Web Chat may render them as structured controls such as cards or buttons.

Example:

```text
Friday, Sep 4

[ 10:30 ]
[ 14:00 ]
[ 16:30 ]
```

The UI selection is a trusted presentation event for an already-issued candidate identifier. It must not permit the browser or model to invent date/time/provider state.

The server remains authoritative for:

- candidate identity;
- candidate expiry;
- appointment type;
- resource/location;
- exact instant/timezone;
- current availability/revalidation.

## Web Chat structured confirmation

Web may use a confirmation card such as:

```text
Vaccination
Friday, Sep 4 · 14:00
Main Clinic

[Confirm appointment]
```

The button is bound to the exact pending action intent on the server.

Clicking an expired, invalidated, consumed, stale, or mismatched confirmation control must fail closed and trigger a safe refresh/reprepare flow rather than execute the stale mutation.

The confirmation control is single-use at the logical action level even if the browser retries the request.

## Web Chat identity collection

When a new booking requires contactable identity, Web Chat should prefer structured secure fields rather than letting the LLM become the identity database writer.

Conceptual flow:

```text
booking task requires contact identity
        ↓
structured contact component
        ↓
application validates / normalizes
        ↓
trusted match or safe creation policy
        ↓
conversation continues
```

The model may explain why information is needed but cannot authoritatively decide that a free-text name/phone belongs to an existing customer.

Existing-customer operations that need verification must use a dedicated verification flow or handoff rather than weakening the identity policy.

## Web Chat response style

Web responses should remain concise and operational despite the richer UI.

Preferred pattern:

```text
answer the question
    ↓
show the relevant trusted option/state
    ↓
ask for the next minimal choice
```

Avoid long generic assistant essays when a small number of actions/options would progress the task.

## Web Chat session loss

If the browser/session disappears while an action is `AWAITING_CONFIRMATION`, Avenlyo must not infer consent.

A later session must re-establish sufficient trusted context, reload durable action state, validate expiry/version/provider truth, and obtain fresh confirmation where required.

A mutation that had already reached trusted success remains successful regardless of browser state.

## SMS — product role

SMS is Avenlyo's durable asynchronous conversational channel.

Its strengths are:

- provider-authenticated inbound transport;
- normalized phone-bound context;
- durable asynchronous replies;
- provider delivery status;
- low-friction customer continuation without keeping a browser open.

SMS has less structured UI than Web, so ambiguity must be controlled through concise wording and durable pending-action state.

## SMS inbound authority

Inbound SMS is trusted only after provider webhook/authentication checks succeed and the `From` / `To` addresses are normalized by application code.

A trusted inbound sender establishes `CHANNEL_BOUND` identity evidence subject to scoped matching rules.

A phone number may still be shared or reassigned; it is not universal customer authorization.

## SMS message replay

The provider message identifier is the durable replay identity for one inbound transport message.

Duplicate webhook delivery must coalesce into one logical inbound message and one logical interpretation/confirmation event.

The same inbound provider message must never execute the same provider mutation twice.

## SMS response style

SMS answers should be short, self-contained, and easy to respond to asynchronously.

For availability, send a small number of choices rather than a long list.

Example:

> Friday has 10:30, 14:00, or 16:30 available. Which works best?

For mutations, the exact target/action must be restated before the confirmation turn.

Example:

> Shall I book Bella's vaccination for Friday, Sep 4 at 14:00 at Main Clinic?

A later clear `yes` may confirm only the current exact pending intent associated with that conversation.

## SMS STOP / START / HELP handling

Provider-recognized opt-out/control signals must be deterministic messaging-policy events, not free-form LLM decisions.

Representative behavior:

```text
STOP
 ↓
trusted messaging policy
 ↓
suppress future prohibited outbound messaging
```

`START` and `HELP` are likewise interpreted through product/provider messaging policy.

The model cannot override an opt-out state merely because the customer later asks an unrelated business question.

## Conversational SMS vs proactive outbound

A customer sending a message to the business and receiving a direct service response is not the same authority as proactive marketing/follow-up outreach later.

The product must distinguish:

- transactional/conversational replies;
- appointment reminders where configured and authorized;
- proactive lead follow-up;
- marketing or future campaign communication.

Lead creation never implies consent for unrestricted proactive SMS.

Cross-channel proactive communication requires its own consent/policy boundary.

## SMS media

Receiving provider metadata indicating an image or other media attachment does not mean the model has actually viewed or safely interpreted the media.

Until a dedicated media capability and policy are explicitly implemented:

- Avenlyo must not claim it reviewed an attached image;
- it must not diagnose an animal from an image;
- it must not assess whether a vehicle is safe from an image;
- it must not make clinical/eligibility judgments from a Medspa image;
- safety-sensitive or action-blocking media cases should be handed to a human when needed.

## Voice — product role

Voice is the realtime conversational channel.

It uses the same business/action semantics as Web and SMS but a different interaction rhythm:

```text
caller utterance
  ↓
short agent response / approved tool step
  ↓
caller utterance
  ↓
next step
```

Latency and clarity are first-class UX constraints, but realtime behavior does not weaken confirmation or provider-truth rules.

## Voice response style

Voice should:

- speak naturally and briefly;
- prefer short sentences;
- ask one question at a time;
- avoid narrating internal tool calls;
- avoid reading URLs unless necessary;
- present only a small number of spoken choices at once;
- never claim an external action succeeded before the trusted tool/provider boundary reports success.

## Voice initial disclosure

The call begins with a clear AI Front Office disclosure in product-approved language, for example:

> Thanks for calling [Business]. I'm Avenlyo's AI Front Office. How can I help?

The product must not present the voice agent as a human receptionist.

## Voice confirmation

Voice mutations require an exact spoken summary immediately before the confirmation turn.

Example:

> Shall I move Bella's Tuesday 10:00 appointment to Thursday at 14:30?

Avenlyo then waits for a new caller utterance.

The confirmation must be attributable to caller input, not assistant speech, tool output, or an older transcript.

The same exact pending-action state, expiry, identity, and provider checks that apply to text channels still apply.

## Voice replay identity

Where the realtime transport exposes durable call/transcript event identity, the confirmation/execution boundary should bind the action to:

```text
trusted call identity
+
trusted caller transcript/event identity
+
exact action intent identity
```

Replay of the same caller transcript event cannot execute the action twice.

## Voice interruption / barge-in

Realtime voice must permit the caller to interrupt long responses or correct a pending option before commitment.

A new caller correction may invalidate or supersede an uncommitted pending proposal.

Barge-in never reverses a provider mutation that already succeeded. Any post-commit change becomes a new governed lifecycle action.

## Voice transfer vs human handoff

Live call transfer and Inbox human handoff are separate capabilities.

`transfer_call` means an actual realtime call-transfer capability and must only be represented as successful after trusted transfer success.

A human handoff means durable human-attention work in Avenlyo.

If live transfer is unavailable, unsupported, or fails, Avenlyo may create a human handoff where policy allows, but must not tell the caller they were transferred.

Likewise, claiming a Voice handoff in Inbox does not imply that a historical or active call was transferred.

## Voice to SMS follow-up

Voice may offer an SMS follow-up only through an explicit consent flow.

The caller ID/transport phone number remains trusted runtime context; the model must not need to read or ask the caller to repeat the full number merely to create the consent binding.

Conceptual flow:

```text
prepare follow-up consent
      ↓
ask caller whether they want a text
      ↓
wait for a new caller response
      ↓
record explicit consent
      ↓
only then enable the approved cross-channel follow-up action
```

A generic call conversation does not automatically authorize later SMS outreach.

## Voice disconnect

A call ending while an action is awaiting confirmation is not confirmation.

A later call must re-establish current identity/target state, candidate validity, appointment version, and provider truth before presenting and confirming any mutation again.

A provider mutation that succeeded before disconnect remains authoritative.

## Cross-channel customer relationship

A safely resolved customer may have multiple independent conversation records:

```text
Customer
 ├─ Web conversation
 ├─ SMS conversation
 └─ Voice call/conversation
```

Avenlyo may connect these records at the Customer 360 level when identity policy allows.

The product does not need to flatten all channel histories into one giant transcript.

Channel-specific event provenance must remain auditable.

## Cross-channel pending work

A customer may begin one task on one channel and continue on another only after trusted re-entry checks.

Durable product objects may survive the switch, including a customer record, appointment, lead, provider operation, or still-valid prepared intent.

However, channel transition always triggers the applicable revalidation and fresh-confirmation requirements before consequential execution.

## Human control by channel

### Web

A human operator may take over the same visible web conversation. The AI becomes silent under the locked Human Handoff Contract.

### SMS

A human operator may reply into the same phone conversation. AI outbound sends are suppressed while human ownership applies.

### Voice

Human handling may be a live transfer where capability exists, or a durable post-call/exception Inbox work item. These are distinct outcomes and must be represented truthfully.

## Customer-facing errors

Raw infrastructure/provider details must not be exposed to customers.

Do not expose examples such as:

- Twilio error codes;
- OpenAI provider details;
- Google Calendar API status codes;
- internal tool names, identifiers, or stack traces.

Channel-appropriate customer language should state the product truth.

For ordinary unavailable capability:

> I can't reliably complete that right now.

For an unknown external mutation outcome:

> I can't reliably verify the result yet, so I won't repeat the action and risk doing it twice.

Exact wording may vary by channel, but the truth classification may not.

## Channel presentation of appointment candidates

The same trusted candidate set may render differently:

| Channel | Preferred V1 presentation |
| --- | --- |
| Web Chat | cards/buttons or small structured choice list |
| SMS | concise text or numbered options |
| Voice | a small number of spoken options |

The underlying candidate identifiers and exact scheduling state remain the same trusted objects.

The model cannot invent channel-specific availability.

## Locked channel invariants

The following are product law for V1:

1. Web, SMS, and Voice use the same Front Office product semantics.
2. No channel has weaker identity, confirmation, appointment, handoff, or provider-truth rules.
3. Channel/session identity is not automatically customer identity.
4. Every inbound transport event is replay-safe where the transport supplies stable identity.
5. Confirmation from one channel does not silently authorize a pending mutation on another channel.
6. Channel loss never becomes implicit confirmation and never erases a trusted successful provider mutation.
7. Cross-channel proactive contact requires its own approved consent/policy basis.
8. STOP/START/HELP-style provider messaging controls are deterministic policy events, not LLM interpretation authority.
9. Voice live transfer and durable human handoff remain separate product capabilities.
10. Structured Web UI may reduce ambiguity but cannot bypass server-side action state.
11. SMS media is not treated as understood until an approved media capability exists.
12. Voice realtime UX may be faster, but its explicit mutation confirmation remains at least as strict as text channels.

## Acceptance scenarios

Implementation/product acceptance must cover at least these channel scenarios:

- Web candidate button is clicked after candidate expiry → no commit; refresh/reprepare.
- Web confirmation request is replayed → one logical mutation.
- Web anonymous visitor requests an existing appointment → verification/handoff boundary, no record enumeration.
- Same SMS provider webhook arrives twice → one logical inbound message.
- SMS `STOP` arrives → deterministic outbound suppression policy, not model improvisation.
- Customer sends only an image in a safety-sensitive context → no visual diagnosis claim; human path where needed.
- Voice customer interrupts an offered slot before confirmation → stale proposal does not commit.
- Voice call disconnects while awaiting confirmation → no mutation.
- Voice mutation succeeds but final spoken response fails → provider truth remains successful.
- Voice live transfer is unsupported → handoff may be created, but transfer is not falsely claimed.
- Web booking intent followed by generic SMS `yes` → no automatic cross-channel commit; action must be revalidated/re-presented.
- Customer safely resolves to one Customer 360 across SMS and Voice → channel histories remain distinct and provenance-preserving.

## Implementation guidance

Existing channel implementations already provide useful foundations that should be preserved:

- Web Chat uses an opaque chat token, trusted origin/session boundary, bounded messages, client message identifiers, and durable server-side conversation state.
- SMS uses provider-authenticated inbound webhooks, normalized E.164 sender/recipient context, provider message IDs, status callbacks, and normalized provider opt-out metadata.
- Voice uses short realtime instructions, separate caller/assistant transcript events, bounded tool schemas, explicit booking/change confirmation rules, and an explicit SMS follow-up consent flow.

These foundations support this contract but do not replace the product-level invariants above.

## Contract relationship

This contract does not supersede the other locked Phase 22A contracts.

In any conflict, the stricter applicable authority/identity/confirmation/provider-truth rule wins. Channel UX may make a safe operation easier to complete, but it cannot make an unsafe operation permissible.
