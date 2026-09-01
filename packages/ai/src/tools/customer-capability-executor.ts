import type { AgentExecutionContext, AgentToolCall } from '../agent/types';
import type {
  ActiveToolName,
  RuntimeKnowledgeSearchResult,
  ToolExecutionResult,
  ToolExecutor,
} from './types';

export interface CustomerSchedulingToolCapabilities {
  readonly booking: boolean;
  readonly cancel: boolean;
  readonly lookup: boolean;
  readonly reschedule: boolean;
}

const bookingTools = new Set<ActiveToolName>([
  'get_available_appointments',
  'prepare_appointment_booking',
  'book_appointment',
]);
const rescheduleTools = new Set<ActiveToolName>([
  'get_reschedule_options',
  'prepare_appointment_reschedule',
  'reschedule_appointment',
]);
const cancellationTools = new Set<ActiveToolName>([
  'prepare_appointment_cancellation',
  'cancel_appointment',
]);

function allowed(name: string, capabilities: CustomerSchedulingToolCapabilities): boolean {
  if (bookingTools.has(name as ActiveToolName)) return capabilities.booking;
  if (name === 'get_upcoming_appointments') {
    return capabilities.lookup || capabilities.reschedule || capabilities.cancel;
  }
  if (rescheduleTools.has(name as ActiveToolName)) return capabilities.reschedule;
  if (cancellationTools.has(name as ActiveToolName)) return capabilities.cancel;
  return true;
}

function rejected(call: AgentToolCall): ToolExecutionResult {
  return {
    execution: {
      callId: call.callId,
      name: call.name,
      status: 'rejected',
      summary: 'Tool is unavailable for the current trusted capability state.',
    },
    handoffRequested: false,
    modelOutput: JSON.stringify({ ok: false, message: 'The requested action is unavailable.' }),
    sources: [],
  };
}

/**
 * Narrows a source-controlled executor with current application-owned customer capability state.
 *
 * Provider/runtime state decides what the model can see. The same check is repeated on execute so a
 * forged or stale provider tool call cannot bypass the advertised tool list.
 */
export class CustomerCapabilityToolExecutor implements ToolExecutor {
  public readonly tools;

  public constructor(
    private readonly delegate: ToolExecutor,
    private readonly capabilities: CustomerSchedulingToolCapabilities,
  ) {
    this.tools = delegate.tools.filter((tool) => allowed(tool.name, capabilities));
  }

  public execute(
    call: AgentToolCall,
    context: AgentExecutionContext,
  ): Promise<ToolExecutionResult> {
    return allowed(call.name, this.capabilities)
      ? this.delegate.execute(call, context)
      : Promise.resolve(rejected(call));
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
}
