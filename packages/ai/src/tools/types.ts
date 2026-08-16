import type { z } from 'zod';

import type {
  AgentExecutionContext,
  AgentFunctionTool,
  AgentToolCall,
  AgentToolExecution,
  KnowledgeSource,
} from '../agent/types';

export const futureToolNames = [
  'find_customer',
  'create_customer',
  'create_lead',
  'get_available_appointments',
  'book_appointment',
  'reschedule_appointment',
  'cancel_appointment',
  'send_sms',
  'transfer_call',
] as const;

export type FutureToolName = (typeof futureToolNames)[number];
export type ActiveToolName = 'request_human_help' | 'search_business_knowledge';

/**
 * Deliberately inactive contracts reserve product vocabulary without authorizing integration,
 * persistence, or provider exposure. A future phase must supply schemas and a trusted executor.
 */
export interface FutureToolContract {
  readonly name: FutureToolName;
  readonly requiredIntegration: 'calendar' | 'crm' | 'messaging' | 'telephony';
}

export const futureToolContracts: readonly FutureToolContract[] = [
  { name: 'find_customer', requiredIntegration: 'crm' },
  { name: 'create_customer', requiredIntegration: 'crm' },
  { name: 'create_lead', requiredIntegration: 'crm' },
  { name: 'get_available_appointments', requiredIntegration: 'calendar' },
  { name: 'book_appointment', requiredIntegration: 'calendar' },
  { name: 'reschedule_appointment', requiredIntegration: 'calendar' },
  { name: 'cancel_appointment', requiredIntegration: 'calendar' },
  { name: 'send_sms', requiredIntegration: 'messaging' },
  { name: 'transfer_call', requiredIntegration: 'telephony' },
];

export interface AgentToolServices {
  requestHumanHelp(
    input: {
      readonly reason: string;
      readonly toolCallId: string;
      readonly urgency: 'normal' | 'urgent';
    },
    context: AgentExecutionContext,
  ): Promise<{ readonly created: boolean }>;
  searchBusinessKnowledge(
    input: { readonly query: string; readonly toolCallId: string },
    context: AgentExecutionContext,
  ): Promise<readonly KnowledgeSource[]>;
}

export interface ToolDefinition<TSchema extends z.ZodType> {
  readonly function: AgentFunctionTool;
  readonly name: ActiveToolName;
  readonly schema: TSchema;
}

export interface ToolExecutionResult {
  readonly execution: AgentToolExecution;
  readonly handoffRequested: boolean;
  readonly modelOutput: string;
  readonly sources: readonly KnowledgeSource[];
}

export interface ToolExecutor {
  execute(call: AgentToolCall, context: AgentExecutionContext): Promise<ToolExecutionResult>;
  readonly tools: readonly AgentFunctionTool[];
}
