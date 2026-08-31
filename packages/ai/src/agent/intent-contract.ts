export const customerIntentNames = [
  'SAFETY_ESCALATION',
  'HUMAN_REQUEST',
  'CONFIRMATION_RESPONSE',
  'APPOINTMENT_BOOK',
  'APPOINTMENT_RESCHEDULE',
  'APPOINTMENT_CANCEL',
  'APPOINTMENT_LOOKUP',
  'BUSINESS_INFORMATION',
  'SERVICE_INTEREST',
  'COMPLAINT_OR_EXCEPTION',
  'GENERAL_CONVERSATION',
  'OUT_OF_SCOPE',
] as const;

export type CustomerIntent = (typeof customerIntentNames)[number];

export type IntentPrecedenceTier =
  | 'interrupt'
  | 'pending_confirmation'
  | 'mutation'
  | 'read_only_or_exception'
  | 'service_interest'
  | 'general';

export interface AgentIntentFrame {
  readonly interrupts: readonly Extract<CustomerIntent, 'HUMAN_REQUEST' | 'SAFETY_ESCALATION'>[];
  readonly modifiers: Readonly<Record<string, string>>;
  readonly primaryTask: Exclude<
    CustomerIntent,
    'CONFIRMATION_RESPONSE' | 'HUMAN_REQUEST' | 'SAFETY_ESCALATION'
  > | null;
  readonly secondaryTasks: readonly Exclude<
    CustomerIntent,
    'CONFIRMATION_RESPONSE' | 'HUMAN_REQUEST' | 'SAFETY_ESCALATION'
  >[];
  readonly confirmationResponse: boolean;
}

const intentTier: Readonly<Record<CustomerIntent, IntentPrecedenceTier>> = {
  SAFETY_ESCALATION: 'interrupt',
  HUMAN_REQUEST: 'interrupt',
  CONFIRMATION_RESPONSE: 'pending_confirmation',
  APPOINTMENT_BOOK: 'mutation',
  APPOINTMENT_RESCHEDULE: 'mutation',
  APPOINTMENT_CANCEL: 'mutation',
  APPOINTMENT_LOOKUP: 'read_only_or_exception',
  BUSINESS_INFORMATION: 'read_only_or_exception',
  COMPLAINT_OR_EXCEPTION: 'read_only_or_exception',
  SERVICE_INTEREST: 'service_interest',
  GENERAL_CONVERSATION: 'general',
  OUT_OF_SCOPE: 'general',
};

const precedence: readonly IntentPrecedenceTier[] = [
  'interrupt',
  'pending_confirmation',
  'mutation',
  'read_only_or_exception',
  'service_interest',
  'general',
];

export function intentPrecedenceTier(intent: CustomerIntent): IntentPrecedenceTier {
  return intentTier[intent];
}

export function isInterruptIntent(
  intent: CustomerIntent,
): intent is Extract<CustomerIntent, 'HUMAN_REQUEST' | 'SAFETY_ESCALATION'> {
  return intentTier[intent] === 'interrupt';
}

export function isMutatingCustomerIntent(
  intent: CustomerIntent,
): intent is Extract<
  CustomerIntent,
  'APPOINTMENT_BOOK' | 'APPOINTMENT_CANCEL' | 'APPOINTMENT_RESCHEDULE'
> {
  return intentTier[intent] === 'mutation';
}

/**
 * Selects the highest-precedence intent without pretending that intents in the same tier have a
 * product-defined order. Within a tier the caller's order is retained.
 */
export function highestPrecedenceIntent(
  intents: readonly CustomerIntent[],
): CustomerIntent | null {
  for (const tier of precedence) {
    const match = intents.find((intent) => intentTier[intent] === tier);
    if (match) return match;
  }
  return null;
}

export const intentOperatingInstructions = `INTENT OPERATING MODEL
Understand each customer turn as four layers when they are present: interrupt signals, one primary task, optional secondary tasks, and modifiers/corrections. Do not force a multi-intent customer message into one flat label.

Allowed customer intents: ${customerIntentNames.join(', ')}.
LEAD is not a customer intent. A lead is a business outcome that may result from genuine service interest or another qualifying interaction.

Precedence is: safety/human interrupts → a valid response to one current pending confirmation → appointment mutations → read-only/exception work → service interest → general/out-of-scope conversation.

A safety escalation or explicit human request may suspend an otherwise valid appointment flow. Treat a confirmation response as authorization only when the application has a current exact pending action for it. A correction invalidates the stale action and requires the affected action to be prepared again.

At most one consequential mutation may be pending confirmation at a time. If a customer requests multiple distinct mutations, sequence them as separate prepare → confirm → commit → verify cycles unless the product exposes one supported atomic operation such as a reschedule. One ambiguous “yes” never authorizes multiple mutations.

Intent is not permission. Understanding what the customer wants never bypasses capability, identity, target disambiguation, provider support, product/industry policy, current confirmation, or trusted execution-success requirements.`;
