import type {
  AgentConversationWorkState,
  AgentExecutionContext,
  AgentFunctionTool,
  AgentToolCall,
} from '../agent/types';
import type {
  ActiveToolName,
  RuntimeKnowledgeSearchResult,
  ToolExecutionResult,
  ToolExecutor,
} from './types';

const executionToolForIntent = {
  APPOINTMENT_BOOK: 'book_appointment',
  APPOINTMENT_CANCEL: 'cancel_appointment',
  APPOINTMENT_RESCHEDULE: 'reschedule_appointment',
} as const satisfies Readonly<
  Record<
    NonNullable<AgentConversationWorkState['pendingMutation']>['intent'],
    ActiveToolName
  >
>;

const executionTools = new Set<ActiveToolName>(Object.values(executionToolForIntent));
const prepareMutationTools = new Set<ActiveToolName>([
  'prepare_appointment_booking',
  'prepare_appointment_cancellation',
  'prepare_appointment_reschedule',
]);

type PendingMutation = NonNullable<AgentConversationWorkState['pendingMutation']>;

/**
 * Application-only authority captured from a trusted prepare result before the model-visible payload
 * is redacted. Never serialize this object into provider input or customer output.
 */
export interface PreparedMutationAuthority {
  readonly actionIntentId: string;
  readonly intent: PendingMutation['intent'];
}

export type MutationAuthorityRevalidator = (
  pending: PendingMutation,
  context: AgentExecutionContext,
) => Promise<boolean>;

function isActiveToolName(value: string): value is ActiveToolName {
  return [
    'capture_lead',
    'request_human_help',
    'search_business_knowledge',
    'get_available_appointments',
    'prepare_appointment_booking',
    'book_appointment',
    'get_upcoming_appointments',
    'get_reschedule_options',
    'prepare_appointment_reschedule',
    'reschedule_appointment',
    'prepare_appointment_cancellation',
    'cancel_appointment',
  ].includes(value);
}

function allowedByWorkState(name: string, workState: AgentConversationWorkState): boolean {
  if (!isActiveToolName(name)) return false;
  const pending = workState.pendingMutation;
  if (!pending) return !executionTools.has(name);
  if (!executionTools.has(name)) return true;
  return executionToolForIntent[pending.intent] === name;
}

function publicTool(tool: AgentFunctionTool): AgentFunctionTool {
  if (!executionTools.has(tool.name as ActiveToolName)) return tool;
  return {
    ...tool,
    parameters: { additionalProperties: false, properties: {}, required: [], type: 'object' },
  };
}

function rejected(
  call: AgentToolCall,
  summary = 'Tool is unavailable for the current trusted work state.',
): ToolExecutionResult {
  return {
    execution: {
      callId: call.callId,
      name: call.name,
      status: 'rejected',
      summary,
    },
    handoffRequested: false,
    modelOutput: JSON.stringify({ ok: false, message: 'The requested action is unavailable.' }),
    sources: [],
  };
}

/**
 * Expected mutation refusals are classified by the trusted service (`confirmation_required`,
 * `unavailable`, `unknown`, ...). If a consequential execution instead comes back as a generic
 * failed tool result with no outcome, the provider boundary cannot be proven untouched from this
 * layer. Escalate conservatively rather than allowing another normal model turn to guess/retry.
 */
function requireHumanReviewForUnclassifiedMutationFailure(
  result: ToolExecutionResult,
): ToolExecutionResult {
  if (result.execution.status !== 'failed' || result.handoffRequested) return result;
  try {
    const parsed = JSON.parse(result.modelOutput) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).outcome === 'string'
    ) {
      return result;
    }
  } catch {
    // A malformed failure payload is itself unclassified and therefore requires review.
  }
  return { ...result, handoffRequested: true };
}

function preparedAuthority(
  call: AgentToolCall,
  result: ToolExecutionResult,
): PreparedMutationAuthority | null {
  if (!isActiveToolName(call.name) || !prepareMutationTools.has(call.name)) return null;
  if (result.execution.status !== 'succeeded') return null;
  try {
    const parsed = JSON.parse(result.modelOutput) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.outcome !== 'ready') return null;
    const intent = record.intent;
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return null;
    const fields = intent as Record<string, unknown>;
    if (call.name === 'prepare_appointment_booking') {
      return typeof fields.bookingIntentId === 'string' && fields.bookingIntentId
        ? { actionIntentId: fields.bookingIntentId, intent: 'APPOINTMENT_BOOK' }
        : null;
    }
    const changeIntentId = fields.changeIntentId;
    if (typeof changeIntentId !== 'string' || !changeIntentId) return null;
    return {
      actionIntentId: changeIntentId,
      intent:
        call.name === 'prepare_appointment_cancellation'
          ? 'APPOINTMENT_CANCEL'
          : 'APPOINTMENT_RESCHEDULE',
    };
  } catch {
    return null;
  }
}

function redactPreparedActionIntent(
  call: AgentToolCall,
  result: ToolExecutionResult,
): ToolExecutionResult {
  if (!isActiveToolName(call.name) || !prepareMutationTools.has(call.name)) return result;
  try {
    const parsed = JSON.parse(result.modelOutput) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
    const record = parsed as Record<string, unknown>;
    const intent = record.intent;
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return result;
    const safeIntent = { ...(intent as Record<string, unknown>) };
    delete safeIntent.bookingIntentId;
    delete safeIntent.changeIntentId;
    delete safeIntent.booking_intent_id;
    delete safeIntent.change_intent_id;
    return {
      ...result,
      modelOutput: JSON.stringify({ ...record, intent: safeIntent }),
    };
  } catch {
    return {
      ...result,
      modelOutput: JSON.stringify({
        ok: false,
        message: 'The prepared action could not be represented safely.',
      }),
    };
  }
}

/**
 * Turn-scoped policy wrapper around the source-controlled executor.
 *
 * It serves four purposes that must remain application-owned rather than model-owned:
 * - a pending consequential mutation exposes only its matching execution tool, while prepare tools
 *   remain available so a material customer correction can atomically replace the stale pending
 *   intent at the trusted persistence boundary;
 * - execution tool authority is bound to the opaque action-intent id from trusted work state, so
 *   the model never receives or chooses that identifier;
 * - a successful prepare retains the opaque authority only for the application adapter while its
 *   model-visible payload is redacted, allowing the adapter to persist/bind the exact confirmation;
 * - a customer adapter may revalidate that exact authority immediately before consequential
 *   execution, closing takeover, expiry, correction, and conflict races without teaching this
 *   package anything about the database.
 */
export class WorkStateToolExecutor implements ToolExecutor {
  public readonly tools: readonly AgentFunctionTool[];
  private preparedMutation: PreparedMutationAuthority | null = null;

  public constructor(
    private readonly delegate: ToolExecutor,
    private readonly workState: AgentConversationWorkState,
    private readonly revalidateMutationAuthority?: MutationAuthorityRevalidator,
  ) {
    this.tools = delegate.tools
      .filter((tool) => allowedByWorkState(tool.name, workState))
      .map(publicTool);
  }

  /** Server-side only. Callers must never serialize the returned opaque identifier to a model/UI. */
  public preparedMutationAuthority(): PreparedMutationAuthority | null {
    return this.preparedMutation;
  }

  public searchKnowledgeForRuntime(
    query: string,
    context: AgentExecutionContext,
  ): Promise<RuntimeKnowledgeSearchResult> {
    if (this.delegate.searchKnowledgeForRuntime) {
      return this.delegate.searchKnowledgeForRuntime(query, context);
    }
    return Promise.resolve({
      diagnostic: {
        knowledgeOutcome: 'failed',
        matches: [],
        origin: 'runtime_forced_search',
        qualifiedCount: 0,
        queryLength: query.length,
        queryMatchesCustomerTurn: true,
        retrievedCount: 0,
        toolCallId: 'runtime-forced-search',
      },
      failed: true,
      sources: [],
    });
  }

  public async execute(
    call: AgentToolCall,
    context: AgentExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!allowedByWorkState(call.name, this.workState)) return rejected(call);

    const pending = this.workState.pendingMutation;
    if (pending && executionTools.has(call.name as ActiveToolName)) {
      if (this.revalidateMutationAuthority) {
        try {
          if (!(await this.revalidateMutationAuthority(pending, context))) {
            return rejected(call, 'Trusted mutation authority changed before execution.');
          }
        } catch {
          return rejected(call, 'Trusted mutation authority could not be revalidated.');
        }
      }
      const trustedArguments =
        pending.intent === 'APPOINTMENT_BOOK'
          ? { booking_intent_id: pending.actionIntentId }
          : { change_intent_id: pending.actionIntentId };
      const result = await this.delegate.execute(
        { ...call, arguments: JSON.stringify(trustedArguments) },
        context,
      );
      return requireHumanReviewForUnclassifiedMutationFailure(result);
    }

    const result = await this.delegate.execute(call, context);
    const authority = preparedAuthority(call, result);
    if (authority) this.preparedMutation = authority;
    return redactPreparedActionIntent(call, result);
  }
}
