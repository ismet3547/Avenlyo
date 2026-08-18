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
export type ActiveToolName =
  | 'request_human_help'
  | 'search_business_knowledge'
  | 'get_available_appointments'
  | 'prepare_appointment_booking'
  | 'book_appointment'
  | 'get_upcoming_appointments'
  | 'get_reschedule_options'
  | 'prepare_appointment_reschedule'
  | 'reschedule_appointment'
  | 'prepare_appointment_cancellation'
  | 'cancel_appointment';

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
  readonly scheduling?: {
    getAvailableAppointments(
      input: {
        readonly appointmentType: string;
        readonly dates: readonly string[];
        readonly toolCallId: string;
      },
      context: AgentExecutionContext,
    ): Promise<
      readonly {
        readonly candidateId: string;
        readonly endsAt: string;
        readonly expiresAt: string;
        readonly resourceName: string;
        readonly startsAt: string;
        readonly timezone: string;
        readonly typeName: string;
      }[]
    >;
    prepareAppointmentBooking(
      input: {
        readonly candidateId: string;
        readonly subjectName: string | null;
        readonly toolCallId: string;
      },
      context: AgentExecutionContext,
    ): Promise<{
      readonly intent: {
        readonly bookingIntentId: string;
        readonly startsAt: string;
        readonly status: string;
        readonly timezone: string;
        readonly typeName: string;
      } | null;
      readonly outcome: 'ambiguous' | 'not_found' | 'ready';
    }>;
    bookAppointment(
      input: { readonly bookingIntentId: string; readonly toolCallId: string },
      context: AgentExecutionContext,
    ): Promise<{
      readonly outcome: 'booked' | 'confirmation_required' | 'unavailable' | 'unknown';
    }>;
  };
  readonly appointmentLifecycle?: {
    getUpcomingAppointments(input: { readonly toolCallId: string }, context: AgentExecutionContext): Promise<readonly { readonly appointmentReference: string; readonly endsAt: string; readonly startsAt: string; readonly timezone: string; readonly title: string }[]>;
    getRescheduleOptions(input: { readonly appointmentReference: string; readonly dates: readonly string[]; readonly toolCallId: string }, context: AgentExecutionContext): Promise<readonly { readonly candidateId: string; readonly endsAt: string; readonly startsAt: string; readonly timezone: string }[]>;
    prepareReschedule(input: { readonly candidateId: string; readonly toolCallId: string }, context: AgentExecutionContext): Promise<{ readonly intent: { readonly changeIntentId: string; readonly operation: string; readonly startsAt: string | null; readonly timezone: string | null } | null; readonly outcome: 'not_found' | 'ready' }>;
    prepareCancellation(input: { readonly appointmentReference: string; readonly toolCallId: string }, context: AgentExecutionContext): Promise<{ readonly intent: { readonly changeIntentId: string; readonly operation: string; readonly startsAt: string | null; readonly timezone: string | null } | null; readonly outcome: 'not_found' | 'ready' }>;
    execute(input: { readonly changeIntentId: string; readonly toolCallId: string }, context: AgentExecutionContext): Promise<{ readonly outcome: 'completed' | 'confirmation_required' | 'handoff_required' | 'unavailable' | 'unknown' }>;
  };
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
  readonly knowledgeOutcome?: 'empty_or_unreliable' | 'reliable' | 'failed' | undefined;
  readonly sources: readonly KnowledgeSource[];
}

export interface ToolExecutor {
  execute(call: AgentToolCall, context: AgentExecutionContext): Promise<ToolExecutionResult>;
  readonly tools: readonly AgentFunctionTool[];
}
