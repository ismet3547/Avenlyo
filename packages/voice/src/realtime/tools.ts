import {
  MIN_AGENT_KNOWLEDGE_SIMILARITY,
  requestHumanHelpFunction,
  requestHumanHelpSchema,
  searchBusinessKnowledgeFunction,
  searchBusinessKnowledgeSchema,
} from '@avenlyo/ai';
import type { KnowledgeSource } from '@avenlyo/ai';
import type { IndustryPack } from '@avenlyo/industries';
import { z } from 'zod';

import { MAX_VOICE_TOOL_CALLS } from '../call/limits';
import type {
  VoiceCallContext,
  VoiceFunctionTool,
  VoiceSchedulingServices,
  VoiceToolCall,
  VoiceToolExecution,
} from '../call/types';

export const transferCallSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export const availableAppointmentsSchema = z
  .object({
    appointment_type: z.string().trim().min(1).max(160),
    dates: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .min(1)
      .max(14),
  })
  .strict();
export const prepareAppointmentBookingSchema = z
  .object({
    candidate_id: z.string().uuid(),
    subject_name: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export const bookAppointmentSchema = z.object({ booking_intent_id: z.string().uuid() }).strict();

export const transferCallFunction: VoiceFunctionTool = {
  description:
    'Transfer this caller to the configured business team when they request or need live help.',
  name: 'transfer_call',
  parameters: {
    additionalProperties: false,
    properties: {
      reason: { description: 'A concise operational reason for the transfer.', type: 'string' },
    },
    required: ['reason'],
    type: 'object',
  },
  strict: true,
};

const getAvailableAppointmentsFunction: VoiceFunctionTool = {
  description:
    'Find currently bookable appointment options. Never infer availability; ask the caller for their preferred date first.',
  name: 'get_available_appointments',
  parameters: {
    additionalProperties: false,
    properties: {
      appointment_type: { type: 'string' },
      dates: { items: { type: 'string' }, type: 'array' },
    },
    required: ['appointment_type', 'dates'],
    type: 'object',
  },
  strict: true,
};

const prepareAppointmentBookingFunction: VoiceFunctionTool = {
  description:
    'Prepare one previously offered appointment option from trusted caller context. This does not book.',
  name: 'prepare_appointment_booking',
  parameters: {
    additionalProperties: false,
    properties: {
      candidate_id: { type: 'string' },
      subject_name: { type: 'string' },
    },
    required: ['candidate_id'],
    type: 'object',
  },
  strict: true,
};

const bookAppointmentFunction: VoiceFunctionTool = {
  description:
    'Book a prepared appointment only immediately after the caller has explicitly confirmed the exact offered time, appointment type, and pet.',
  name: 'book_appointment',
  parameters: {
    additionalProperties: false,
    properties: { booking_intent_id: { type: 'string' } },
    required: ['booking_intent_id'],
    type: 'object',
  },
  strict: true,
};

function baseTool(
  tool: typeof searchBusinessKnowledgeFunction | typeof requestHumanHelpFunction,
): VoiceFunctionTool {
  return tool;
}

export function activeVoiceTools(input: {
  readonly industry: IndustryPack;
  readonly schedulingEnabled?: boolean;
  readonly transferEnabled: boolean;
}): readonly VoiceFunctionTool[] {
  const tools: VoiceFunctionTool[] = [
    baseTool(searchBusinessKnowledgeFunction),
    baseTool(requestHumanHelpFunction),
  ];
  if (input.transferEnabled && input.industry.allowedActions.includes('handoff_to_human')) {
    tools.push(transferCallFunction);
  }
  if (input.schedulingEnabled) {
    tools.push(
      getAvailableAppointmentsFunction,
      prepareAppointmentBookingFunction,
      bookAppointmentFunction,
    );
  }
  return tools;
}

export interface VoiceToolServices {
  requestHumanHelp(
    input: {
      readonly reason: string;
      readonly toolCallId: string;
      readonly urgency: 'normal' | 'urgent';
    },
    context: VoiceCallContext,
  ): Promise<{ readonly created: boolean }>;
  searchBusinessKnowledge(
    input: { readonly query: string; readonly toolCallId: string },
    context: VoiceCallContext,
  ): Promise<readonly KnowledgeSource[]>;
  transferCall(
    input: { readonly reason: string; readonly toolCallId: string },
    context: VoiceCallContext,
  ): Promise<{ readonly transferred: boolean }>;
  readonly scheduling?: VoiceSchedulingServices;
}

function output(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(value);
}

function rejected(summary: string): VoiceToolExecution {
  return {
    handoffRequested: false,
    modelOutput: output({ ok: false, message: 'The requested action is unavailable.' }),
    status: 'rejected',
    summary,
    transferred: false,
  };
}

function reliableSources(matches: readonly KnowledgeSource[]): readonly KnowledgeSource[] {
  return matches
    .filter(
      (match) =>
        Number.isFinite(match.similarity) && match.similarity >= MIN_AGENT_KNOWLEDGE_SIMILARITY,
    )
    .slice(0, 3)
    .map((match) => ({
      content: match.content.slice(0, 1_200),
      similarity: Math.max(0, Math.min(1, match.similarity)),
      sourceUrl: match.sourceUrl,
      title: match.title.slice(0, 240),
    }));
}

/** Controlled, sequential live-call executor. Routing and transfer targets are never model inputs. */
export class VoiceToolExecutor {
  private readonly completed = new Map<string, VoiceToolExecution>();
  private executionCount = 0;

  public constructor(
    private readonly context: VoiceCallContext,
    private readonly services: VoiceToolServices,
    private readonly transferEnabled: boolean,
    private readonly schedulingEnabled = false,
  ) {}

  public async execute(call: VoiceToolCall): Promise<VoiceToolExecution> {
    const previous = this.completed.get(call.callId);
    if (previous) return previous;
    if (this.executionCount >= MAX_VOICE_TOOL_CALLS) return rejected('Voice tool limit reached.');
    this.executionCount += 1;

    let rawArguments: unknown;
    try {
      rawArguments = JSON.parse(call.arguments) as unknown;
    } catch {
      return this.store(call.callId, rejected('Malformed tool arguments.'));
    }
    try {
      if (call.name === 'search_business_knowledge') {
        const parsed = searchBusinessKnowledgeSchema.safeParse(rawArguments);
        if (!parsed.success) {
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        }
        const matches = reliableSources(
          await this.services.searchBusinessKnowledge(
            { query: parsed.data.query, toolCallId: call.callId },
            this.context,
          ),
        );
        return this.store(call.callId, {
          handoffRequested: false,
          modelOutput: output({ matches }),
          status: 'succeeded',
          summary: matches.length
            ? `${matches.length} knowledge source(s) found.`
            : 'No reliable knowledge found.',
          transferred: false,
        });
      }
      if (call.name === 'request_human_help') {
        const parsed = requestHumanHelpSchema.safeParse(rawArguments);
        if (!parsed.success) {
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        }
        const handoff = await this.services.requestHumanHelp(
          { ...parsed.data, toolCallId: call.callId },
          this.context,
        );
        return this.store(
          call.callId,
          handoff.created
            ? {
                handoffRequested: true,
                modelOutput: output({ ok: true, requested: true }),
                status: 'succeeded',
                summary: 'Team handoff requested.',
                transferred: false,
              }
            : {
                handoffRequested: false,
                modelOutput: output({
                  ok: false,
                  message: 'The team could not be notified automatically.',
                }),
                status: 'failed',
                summary: 'Handoff was not created.',
                transferred: false,
              },
        );
      }
      if (call.name === 'transfer_call' && this.transferEnabled) {
        const parsed = transferCallSchema.safeParse(rawArguments);
        if (!parsed.success) {
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        }
        const transfer = await this.services.transferCall(
          { ...parsed.data, toolCallId: call.callId },
          this.context,
        );
        return this.store(
          call.callId,
          transfer.transferred
            ? {
                handoffRequested: true,
                modelOutput: output({ ok: true, transferred: true }),
                status: 'succeeded',
                summary: 'Configured transfer started.',
                transferred: true,
              }
            : {
                handoffRequested: false,
                modelOutput: output({
                  ok: false,
                  message: 'The call could not be transferred automatically.',
                }),
                status: 'failed',
                summary: 'Configured transfer failed.',
                transferred: false,
              },
        );
      }
      if (
        call.name === 'get_available_appointments' &&
        this.schedulingEnabled &&
        this.services.scheduling
      ) {
        if (call.schedulingBlocked)
          return this.store(call.callId, rejected('Scheduling is blocked for this call.'));
        const parsed = availableAppointmentsSchema.safeParse(rawArguments);
        if (!parsed.success)
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        const candidates = await this.services.scheduling.getAvailableAppointments(
          {
            appointmentType: parsed.data.appointment_type,
            dates: parsed.data.dates,
            toolCallId: call.callId,
          },
          this.context,
        );
        return this.store(call.callId, {
          handoffRequested: false,
          modelOutput: output({ candidates }),
          status: 'succeeded',
          summary: candidates.length
            ? `${candidates.length} appointment options found.`
            : 'No appointment options found.',
          transferred: false,
        });
      }
      if (
        call.name === 'prepare_appointment_booking' &&
        this.schedulingEnabled &&
        this.services.scheduling
      ) {
        if (call.schedulingBlocked)
          return this.store(call.callId, rejected('Scheduling is blocked for this call.'));
        const parsed = prepareAppointmentBookingSchema.safeParse(rawArguments);
        if (!parsed.success)
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        const prepared = await this.services.scheduling.prepareAppointmentBooking(
          {
            candidateId: parsed.data.candidate_id,
            subjectName: parsed.data.subject_name ?? null,
            toolCallId: call.callId,
          },
          this.context,
        );
        return this.store(call.callId, {
          handoffRequested: false,
          modelOutput: output(prepared),
          status: 'succeeded',
          summary:
            prepared.outcome === 'ready'
              ? 'Booking is ready for explicit confirmation.'
              : 'Booking could not be prepared.',
          transferred: false,
        });
      }
      if (call.name === 'book_appointment' && this.schedulingEnabled && this.services.scheduling) {
        if (call.schedulingBlocked)
          return this.store(call.callId, rejected('Scheduling is blocked for this call.'));
        const parsed = bookAppointmentSchema.safeParse(rawArguments);
        if (!parsed.success)
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        const booked = await this.services.scheduling.bookAppointment(
          {
            bookingIntentId: parsed.data.booking_intent_id,
            confirmationText: call.confirmationText ?? null,
            toolCallId: call.callId,
          },
          this.context,
        );
        return this.store(call.callId, {
          handoffRequested: booked.outcome === 'unknown',
          modelOutput: output(booked),
          status: booked.outcome === 'booked' ? 'succeeded' : 'failed',
          summary: `Booking outcome: ${booked.outcome}.`,
          transferred: false,
        });
      }
      return this.store(call.callId, rejected('Unavailable tool requested.'));
    } catch {
      return this.store(call.callId, {
        handoffRequested: false,
        modelOutput: output({ ok: false, message: 'The requested action could not be completed.' }),
        status: 'failed',
        summary: 'Tool execution failed.',
        transferred: false,
      });
    }
  }

  private store(callId: string, result: VoiceToolExecution): VoiceToolExecution {
    this.completed.set(callId, result);
    return result;
  }
}
