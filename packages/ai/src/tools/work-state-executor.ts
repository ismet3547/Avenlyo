import type {
  AgentConversationWorkState,
  AgentExecutionContext,
  AgentFunctionTool,
  AgentToolCall,
} from '../agent/types';
import type {
  ActiveToolName,
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
  ].includes(value as ActiveToolName);
}

function allowedByWorkState(name: string, workState: AgentConversationWorkState): boolean {
  if (!isActiveToolName(name)) return false;
  const pending = workState.pendingMutation;
  if (!pending) return !executionTools.has(name);
  if (prepareMutationTools.has(name)) return false;
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

function rejected(call: AgentToolCall): ToolExecutionResult {
  return {
    execution: {
      callId: call.callId,
      name: call.name,
      status: 'rejected',
      summary: 'Tool is unavailable for the current trusted work state.',
    },
    handoffRequested: false,
    modelOutput: JSON.stringify({ ok: false, message: 'The requested action is unavailable.' }),
    sources: [],
  };
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
 * It serves two purposes that must remain application-owned rather than model-owned:
 * - a pending consequential mutation prevents preparing a competing mutation and exposes only the
 *   matching execution tool;
 * - execution tool authority is bound to the opaque action-intent id from trusted work state, so
 *   the model never receives or chooses that identifier.
 */
export class WorkStateToolExecutor implements ToolExecutor {
  public readonly searchKnowledgeForRuntime: ToolExecutor['searchKnowledgeForRuntime'];
  public readonly tools: readonly AgentFunctionTool[];

  public constructor(
    private readonly delegate: ToolExecutor,
    private readonly workState: AgentConversationWorkState,
  ) {
    this.searchKnowledgeForRuntime = delegate.searchKnowledgeForRuntime
      ? (query, context) => delegate.searchKnowledgeForRuntime!(query, context)
      : undefined;
    this.tools = delegate.tools
      .filter((tool) => allowedByWorkState(tool.name, workState))
      .map(publicTool);
  }

  public async execute(
    call: AgentToolCall,
    context: AgentExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!allowedByWorkState(call.name, this.workState)) return rejected(call);

    const pending = this.workState.pendingMutation;
    if (pending && executionTools.has(call.name as ActiveToolName)) {
      const trustedArguments =
        pending.intent === 'APPOINTMENT_BOOK'
          ? { booking_intent_id: pending.actionIntentId }
          : { change_intent_id: pending.actionIntentId };
      return this.delegate.execute(
        { ...call, arguments: JSON.stringify(trustedArguments) },
        context,
      );
    }

    return redactPreparedActionIntent(call, await this.delegate.execute(call, context));
  }
}
