import type { VoiceFunctionTool, VoiceToolCall, VoiceToolExecution } from '@avenlyo/voice';

const emptyParameters = {
  additionalProperties: false,
  properties: {},
  required: [],
  type: 'object',
} as const;

const authorityBoundTools = new Set<VoiceFunctionTool['name']>([
  'book_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'confirm_sms_followup_consent',
]);

const authorityKeys = new Set([
  'bookingIntentId',
  'booking_intent_id',
  'changeIntentId',
  'change_intent_id',
  'consentIntentId',
  'consent_intent_id',
]);

type PendingMutation = {
  readonly intentId: string;
  readonly kind: 'book' | 'cancel' | 'reschedule';
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parsedOutput(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key]) => !authorityKeys.has(key))
      .map(([key, nested]) => [key, sanitize(nested)]),
  );
}

function publicDescription(tool: VoiceFunctionTool): string {
  switch (tool.name) {
    case 'book_appointment':
      return 'Book the currently prepared appointment only after the caller explicitly confirms the exact offer. The application supplies the pending action reference.';
    case 'reschedule_appointment':
      return 'Execute the currently prepared reschedule only after the caller explicitly confirms it. The application supplies the pending action reference.';
    case 'cancel_appointment':
      return 'Execute the currently prepared cancellation only after the caller explicitly confirms it. The application supplies the pending action reference.';
    case 'confirm_sms_followup_consent':
      return 'Record SMS follow-up consent only after a later clear yes from the caller. The application supplies the pending consent reference.';
    default:
      return tool.description;
  }
}

/** Provider-visible tool contracts never expose durable mutation-authority identifiers. */
export function customerVisibleVoiceTools(
  tools: readonly VoiceFunctionTool[],
): readonly VoiceFunctionTool[] {
  return tools.map((tool) =>
    authorityBoundTools.has(tool.name)
      ? { ...tool, description: publicDescription(tool), parameters: emptyParameters }
      : tool,
  );
}

/**
 * Call-scoped trusted authority references for realtime voice.
 *
 * Durable action intents remain in the database. This state only remembers the exact reference
 * returned by trusted services during this live sideband session. A reconnect loses the reference
 * and therefore fails closed instead of asking the model to reconstruct or replay it.
 */
export class VoiceToolAuthorityState {
  private pendingConsentIntentId: string | null = null;
  private pendingMutation: PendingMutation | null = null;

  public clearSchedulingAuthority(): void {
    this.pendingMutation = null;
  }

  /** Replaces model arguments for authority-bound tools with trusted call-scoped references. */
  public bind(call: VoiceToolCall): VoiceToolCall {
    if (call.name === 'book_appointment') {
      return {
        ...call,
        arguments:
          this.pendingMutation?.kind === 'book'
            ? JSON.stringify({ booking_intent_id: this.pendingMutation.intentId })
            : '{}',
      };
    }
    if (call.name === 'reschedule_appointment' || call.name === 'cancel_appointment') {
      const expected = call.name === 'reschedule_appointment' ? 'reschedule' : 'cancel';
      return {
        ...call,
        arguments:
          this.pendingMutation?.kind === expected
            ? JSON.stringify({ change_intent_id: this.pendingMutation.intentId })
            : '{}',
      };
    }
    if (call.name === 'confirm_sms_followup_consent') {
      return {
        ...call,
        arguments: this.pendingConsentIntentId
          ? JSON.stringify({ consent_intent_id: this.pendingConsentIntentId })
          : '{}',
      };
    }
    return call;
  }

  /** Captures trusted prepare results, expires single-use authority, and redacts internal IDs. */
  public observe(call: VoiceToolCall, result: VoiceToolExecution): VoiceToolExecution {
    const parsed = parsedOutput(result.modelOutput);
    const top = record(parsed);

    if (call.name === 'prepare_appointment_booking') {
      this.pendingMutation = null;
      const intent = record(top?.intent);
      if (top?.outcome === 'ready' && typeof intent?.bookingIntentId === 'string') {
        this.pendingMutation = { intentId: intent.bookingIntentId, kind: 'book' };
      }
    }

    if (
      call.name === 'prepare_appointment_reschedule' ||
      call.name === 'prepare_appointment_cancellation'
    ) {
      this.pendingMutation = null;
      const intent = record(top?.intent);
      if (top?.outcome === 'ready' && typeof intent?.changeIntentId === 'string') {
        this.pendingMutation = {
          intentId: intent.changeIntentId,
          kind:
            call.name === 'prepare_appointment_reschedule' ? 'reschedule' : 'cancel',
        };
      }
    }

    if (call.name === 'prepare_sms_followup_consent') {
      this.pendingConsentIntentId =
        typeof top?.consent_intent_id === 'string' ? top.consent_intent_id : null;
    }

    if (
      call.name === 'book_appointment' ||
      call.name === 'reschedule_appointment' ||
      call.name === 'cancel_appointment'
    ) {
      if (top?.outcome !== 'confirmation_required') this.pendingMutation = null;
    }

    if (call.name === 'confirm_sms_followup_consent') this.pendingConsentIntentId = null;

    return {
      ...result,
      modelOutput: JSON.stringify(
        parsed === null
          ? { ok: false, message: 'The tool result could not be represented safely.' }
          : sanitize(parsed),
      ),
    };
  }
}
