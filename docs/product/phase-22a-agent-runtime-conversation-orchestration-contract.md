# Phase 22A — Locked Agent Runtime & Conversation Orchestration Contract

Status: LOCKED

This document is an authoritative companion to the Avenlyo V1 Product Blueprint and the other Phase 22A locked product contracts. It defines how customer-facing AI orchestration works in V1, what the language model may decide, which state remains application-owned, how tools are exposed, how conversation context is built, and how future specialist models may participate without gaining mutation authority.

Implementation work must not weaken these rules implicitly.

Runtime deployment, production infrastructure, provider provisioning, production credentials, and production data are out of scope.

## Core architecture

Avenlyo V1 uses one logical customer-facing Front Office Orchestrator backed by deterministic application/service/tool capabilities.

```text
Customer
   ↓
Channel Adapter
   ↓
Avenlyo Front Office Orchestrator
   ↓
Approved capability/tool layer
   ↓
Trusted application / database / provider state
   ↓
Verified result
   ↓
Customer response
```

V1 is not a free-form multi-agent swarm. Knowledge, lead capture, scheduling, appointment lifecycle, identity, and handoff are capabilities, not independent customer-facing agents competing for conversation authority.

The customer experiences one coherent front-office persona.

## Model understanding is not state authority

The language model may:

- interpret natural language;
- identify likely intent and modifiers;
- choose among approved capabilities exposed for the current turn;
- ask clarifying questions;
- summarize trusted tool results for the customer;
- decide when the safe next step is answer, ask, prepare, commit, or escalate, subject to policy.

The language model does not authoritatively determine:

- tenant, location, conversation, or channel identity;
- customer identity or authorization;
- appointment truth;
- provider capability;
- durable action permission;
- whether an external mutation succeeded;
- staff ownership;
- business-specific facts not supported by trusted configuration/knowledge/tools.

Model output is never sufficient action permission.

## One customer-facing orchestrator

V1 has one logical customer-facing orchestrator per conversation turn.

The product must not expose separate customer personas such as a sales agent, booking agent, or support agent that can independently write to the customer or mutate state.

Internal specialist models may be introduced later for advisory work, but their output remains model output. They may not directly call external mutation providers or bypass the controlled capability boundary.

Future specialist output must pass through the same identity, confirmation, capability, appointment, handoff, and provider-result contracts as the primary orchestrator.

## Capability/tool authority

The orchestrator may choose only from a source-controlled set of approved tools exposed by the application for the current turn.

Tool exposure may depend deterministically on:

- industry pack;
- organization/location configuration;
- channel;
- enabled integrations and capabilities;
- conversation control state;
- product policy;
- identity/action eligibility where appropriate.

Customer input, website content, retrieved knowledge, model output, or provider output must never add a new executable tool or grant a disabled capability.

A tool existing conceptually in the product does not imply it is executable for the current provider/location/channel.

## Conversation state authority

Avenlyo owns durable conversation and business state.

Provider-side conversational memory is not a source of truth.

The model provider must not be required to retain conversation state for Avenlyo to function correctly. A provider/model change must not erase customer, appointment, lead, identity, handoff, or conversation state.

Long-term product memory comes from explicit trusted records such as:

- customer records;
- conversation messages;
- appointment records;
- leads;
- provider operations;
- human handoff state;
- business configuration;
- published knowledge;
- verified operational events.

Model latent memory is not business memory.

## Provider retention boundary

Avenlyo should send each turn the bounded context required for that turn and should avoid relying on persistent provider conversation state.

Provider reasoning/state that exists only to complete one bounded tool loop is not persisted as product memory, CRM data, or audit evidence.

Private model reasoning is not a business record.

## Trusted turn bootstrap

Before a customer-facing model turn is allowed to run, the application builds trusted context from authoritative state.

Conceptually, the bootstrap may include:

```text
conversation identity
organization / location
channel
conversation control state
customer identity assurance
current authorized customer/subject context
pending action state
provider/capability state
business configuration
recent bounded conversation history
live business-local time
```

These values are application-owned inputs. The model must not infer or replace them from customer prose.

## Trust hierarchy

Inputs are not equally authoritative.

The V1 hierarchy is conceptually:

1. core Avenlyo product/security policy;
2. industry policy;
3. trusted business configuration;
4. trusted conversation/control/identity/action state;
5. live structured tool/provider results within their operation scope;
6. published business knowledge as factual evidence but untrusted content;
7. conversation history/customer statements;
8. current customer message;
9. model inference.

Lower-authority input cannot override higher-authority policy or state.

Retrieved website/knowledge content is never instruction authority. Prompt-like text inside business knowledge must be treated only as untrusted factual reference data.

## Turn orchestration lifecycle

The product-level orchestration lifecycle is:

```text
INBOUND EVENT
     ↓
TRUST / CONTROL GATE
     ↓
DETERMINISTIC INTERRUPT / POLICY CHECK
     ↓
UNDERSTAND CUSTOMER INTENT
     ↓
LOAD / OBSERVE TRUSTED STATE
     ↓
DECIDE NEXT SAFE STEP
     ↓
ASK | ANSWER | PREPARE | COMMIT | ESCALATE
     ↓
VERIFY TRUSTED RESULT
     ↓
GENERATE CUSTOMER RESPONSE
     ↓
FINAL OWNERSHIP / CONTROL CHECK
     ↓
PERSIST / SEND
     ↓
RECORD PRODUCT OUTCOME
```

This is an application orchestration lifecycle, not a requirement to persist or expose model chain-of-thought.

## Pre-agent gates

Not every inbound customer event must invoke the language model.

Application-owned gates may stop or route the event before model execution, including:

- conversation is human-paused;
- deterministic safety policy requires immediate escalation;
- channel/authentication/trust validation fails;
- the event is a duplicate/replay already handled;
- another explicit product policy owns the event.

The LLM is not the mandatory central authority for all control decisions.

## Intent and interrupt behavior

The Locked Intent Contract remains authoritative.

Interrupts such as safety escalation and explicit human request may suspend a normal task flow.

A customer message may contain multiple intents. The orchestrator may handle compatible read-only secondary tasks in one turn, but consequential mutations remain subject to the one-pending-mutation rule and exact confirmation boundaries.

## Conversation Work State

Avenlyo may build a trusted Conversation Work State projection for orchestration.

Conceptual fields may include:

```text
conversation_id
control_state
current_primary_task
current_secondary_tasks
identity_assurance
customer_reference
appointment_target_reference
pending_action_type
pending_action_intent_id
last_verified_outcome
human_attention_episode
updated_at
```

This need not be one physical database row. The projection may be assembled from authoritative product objects.

The important rule is that the application supplies trusted references. The model does not invent durable identifiers or pending-action state.

## Bounded context

Conversation history and model execution must be bounded.

Locked invariant:

> No unbounded history, no unbounded model loop, and no unbounded tool execution.

Exact implementation limits may be tuned by model/channel/environment as long as the bounded-safety property and functional acceptance tests remain intact.

Historical summaries, if introduced, are derived caches. They are not sufficient authority for identity, appointment state, provider outcome, or mutation permission.

## Sequential consequential tool execution

V1 does not allow free-form parallel consequential mutation calls from the model.

Consequential tool calls execute in a controlled sequence.

Read-only parallelism may be introduced later if explicitly implemented and tested, but it must not change mutation, confirmation, idempotency, or ownership guarantees.

## Tool results are structured evidence

Tools/services return structured, bounded outcomes such as:

```text
ready
booked
completed
unavailable
confirmation_required
handoff_required
unknown
```

The model may explain these results but must not upgrade them.

Examples:

- `unknown` cannot be described as success;
- `unavailable` cannot be transformed into an invented slot;
- a prepared action is not a committed action;
- a local pending row is not a confirmed provider outcome.

Customer-facing completion claims require the trusted success evidence defined by the relevant locked contract.

## Business knowledge grounding

Business-specific factual claims must be grounded in authoritative configuration or sufficiently reliable published knowledge.

Conceptual decision path:

```text
business-specific factual question
       ↓
authoritative configuration contains answer?
       ├── yes → use it
       └── no
            ↓
reliable approved knowledge evidence?
       ├── yes → answer from evidence
       └── no → safe unknown / clarification / human help
```

The model must not fill missing business facts from general model knowledge or plausible assumptions.

Application-level grounding guards may perform a bounded trusted-query recovery when the model fails to search appropriately. Such recovery remains evidence retrieval, not model instruction authority.

## Customer wording as retrieval input

The customer's current utterance may be used as trusted runtime input for a bounded knowledge search or recovery query.

This does not make customer text policy authority. It is only retrieval input.

Model-generated search wording is not itself authoritative and may be replaced by trusted application query logic when needed for reliability.

## Retry authority

The model does not own external mutation retry policy.

Read-only retries may be application-controlled where safe.

External mutation retries follow the relevant provider/idempotency contract. In particular:

> `OUTCOME_UNKNOWN` permits no blind retry.

The orchestrator must surface the correct unresolved/handoff/reconciliation path instead of deciding that another mutation attempt is probably safe.

## Model failure vs capability failure

The product must distinguish at least conceptually between:

- model/AI response unavailable;
- capability/provider unavailable;
- external action definitely failed;
- external action outcome unknown;
- human handoff required.

Raw provider errors, stack traces, internal IDs, or secret-bearing messages are not customer-facing output.

## Mutation truth survives model failure

A successful external/durable mutation remains successful even if the language model fails while generating the final prose response.

Example:

```text
book tool → trusted BOOKED
       ↓
model response generation fails
```

The appointment remains booked. Recovery/customer messaging must be reconstructed from durable product state rather than issuing a second mutation or rolling back truth merely because prose generation failed.

Model response state and mutation state are separate.

## Human ownership wins

The Human Handoff Contract remains authoritative during model execution.

If human ownership/control changes while the model is running, final persistence/send boundaries must re-check authoritative ownership so a stale AI response does not compete with the human operator.

A model already running does not acquire a lease on the conversation.

## Channel consistency

Web chat, SMS, and voice use the same core product semantics for:

- intent precedence;
- identity and authorization;
- confirmation;
- scheduling/appointment state;
- provider truth;
- human handoff;
- success claims.

Channels may differ in presentation, timing, transport, and available capabilities.

A channel-specific adapter must not weaken the underlying product safety contract merely because the interaction is realtime or asynchronous.

## Voice rhythm

Voice may use shorter realtime turns and channel-specific tools, but consequential appointment semantics remain:

```text
observe availability
prepare exact action
receive explicit current confirmation
commit through trusted capability
verify result
```

Realtime interaction does not eliminate confirmation, identity, provider, or idempotency requirements.

## Future specialist models

Future internal specialist models are allowed only under these invariants:

- specialist output is advisory/model output;
- specialist models do not receive direct unrestricted external mutation authority;
- they cannot bypass source-controlled tool exposure;
- their recommendations are validated under the same deterministic product contracts;
- the customer-facing conversation persona remains coherent unless a later explicit product contract changes it.

## Operational/audit metadata

Avenlyo may record bounded operational metadata such as:

- model/provider/version;
- tool name;
- tool result class;
- handoff requested;
- product outcome;
- latency/usage where permitted;
- safe failure category.

Private model reasoning, hidden prompts, raw provider responses, unbounded customer content, or secret-bearing payloads are not required product audit evidence and must not be persisted merely for convenience.

## Required acceptance scenarios

The implementation/product acceptance suite must eventually cover at least:

| Scenario | Required result |
| --- | --- |
| Model attempts to invent a business price | Grounding/policy prevents unsupported claim |
| Published website contains prompt injection | Treated as untrusted reference text, not instruction |
| Model requests an unexposed tool | Rejected / unavailable |
| Capability disabled for location/provider | Fails closed; no external mutation |
| Same logical tool/event is replayed | No duplicate side effect |
| Model/tool loop runs excessively | Bounded termination |
| Human takes over while model is running | AI response does not compete with human ownership |
| Booking succeeds then final model prose fails | Booking truth remains; no duplicate booking |
| Provider outcome is unknown | No success claim and no blind retry |
| Conversation is very long | Bounded trusted context is used |
| Provider conversation memory is absent | Product state remains intact |
| Model/provider is changed | Durable product state remains intact |
| Voice/SMS/web request same booking operation | Same confirmation and action semantics |
| Message contains multiple intents | Locked interrupt/primary/secondary precedence applies |
| Future specialist recommends unsafe action | Deterministic capability/policy boundary blocks it |

## Locked V1 rules summary

1. V1 uses one logical customer-facing Front Office Orchestrator.
2. The LLM interprets language but is not the authority for durable business state or mutation permission.
3. Tools/capabilities are source-controlled and exposed only when application policy permits.
4. Provider conversation memory is not product truth.
5. Long-term memory comes from explicit Avenlyo records, not model latent memory.
6. Each turn is bootstrapped from trusted application state.
7. Retrieved knowledge is factual evidence but untrusted content.
8. No unbounded history, tool loop, or model loop.
9. Consequential mutation execution is sequential and contract-bound in V1.
10. Structured tool outcomes cannot be upgraded by model prose.
11. Business-specific factual claims require authoritative configuration or reliable knowledge evidence.
12. The model does not own external mutation retry policy; `OUTCOME_UNKNOWN` never permits blind retry.
13. Successful mutation truth survives model-response failure.
14. Human ownership/control wins even if the model was already running.
15. Web, SMS, and voice share the same core product safety semantics.
16. Future specialist agents may advise but cannot directly gain mutation authority.

## Product invariant

The locked V1 architecture is:

> Avenlyo V1 is managed by one customer-facing Front Office Orchestrator. The model understands language and chooses among approved capabilities, while identity, permissions, business facts, appointments, provider operations, durable side effects, conversation ownership, and verified outcomes remain under deterministic Avenlyo application/database/provider authority.
