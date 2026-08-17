import { createHash } from 'node:crypto';

import { MAX_TOOL_OUTPUT_CHARACTERS } from '../agent/limits';
import type { AgentExecutionContext, AgentToolCall, KnowledgeSource } from '../agent/types';

import { activeToolDefinitions } from './registry';
import {
  availableAppointmentsSchema,
  bookAppointmentSchema,
  prepareAppointmentBookingSchema,
  requestHumanHelpSchema,
  searchBusinessKnowledgeSchema,
} from './schemas';
import type { AgentToolServices, ToolExecutionResult, ToolExecutor } from './types';

/** Conservative starting floor: a nearest neighbour is not necessarily a reliable business fact. */
export const MIN_AGENT_KNOWLEDGE_SIMILARITY = 0.78;

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function safeJson(value: unknown): string {
  return truncate(JSON.stringify(value), MAX_TOOL_OUTPUT_CHARACTERS);
}

function sanitizedSources(matches: readonly KnowledgeSource[]): readonly KnowledgeSource[] {
  return matches
    .filter(
      (match) =>
        Number.isFinite(match.similarity) && match.similarity >= MIN_AGENT_KNOWLEDGE_SIMILARITY,
    )
    .slice(0, 3)
    .map((match) => ({
      content: truncate(match.content, 1_200),
      similarity: Math.max(0, Math.min(1, match.similarity)),
      sourceUrl: match.sourceUrl ? truncate(match.sourceUrl, 1_000) : null,
      title: truncate(match.title, 240),
    }));
}

function rejected(call: AgentToolCall, summary: string): ToolExecutionResult {
  return {
    execution: { callId: call.callId, name: call.name, status: 'rejected', summary },
    handoffRequested: false,
    modelOutput: safeJson({ ok: false, message: 'The requested action is unavailable.' }),
    sources: [],
  };
}

/** Executes only predeclared tools through trusted services; no model data path reaches a database. */
export class ControlledToolExecutor implements ToolExecutor {
  public readonly tools;

  public constructor(
    private readonly industry: Parameters<typeof activeToolDefinitions>[0],
    private readonly services: AgentToolServices,
  ) {
    this.tools = activeToolDefinitions(industry, services.scheduling !== undefined).map(
      (tool) => tool.function,
    );
  }

  public async execute(
    call: AgentToolCall,
    context: AgentExecutionContext,
  ): Promise<ToolExecutionResult> {
    const definition = activeToolDefinitions(
      this.industry,
      this.services.scheduling !== undefined,
    ).find((tool) => tool.name === call.name);
    if (!definition) return rejected(call, 'Unavailable tool requested.');

    let rawArguments: unknown;
    try {
      rawArguments = JSON.parse(call.arguments) as unknown;
    } catch {
      return rejected(call, 'Malformed tool arguments.');
    }
    try {
      if (call.name === 'search_business_knowledge') {
        const parsed = searchBusinessKnowledgeSchema.safeParse(rawArguments);
        if (!parsed.success) return rejected(call, 'Tool arguments did not pass validation.');
        const sources = sanitizedSources(
          await this.services.searchBusinessKnowledge(
            { query: parsed.data.query, toolCallId: call.callId },
            context,
          ),
        );
        return {
          execution: {
            callId: call.callId,
            name: call.name,
            status: 'succeeded',
            summary: sources.length
              ? `${sources.length} knowledge source(s) found.`
              : 'No knowledge found.',
          },
          handoffRequested: false,
          knowledgeOutcome: sources.length ? 'reliable' : 'empty_or_unreliable',
          modelOutput: safeJson({ matches: sources }),
          sources,
        };
      }

      if (call.name === 'get_available_appointments' && this.services.scheduling) {
        const parsed = availableAppointmentsSchema.safeParse(rawArguments);
        if (!parsed.success) return rejected(call, 'Tool arguments did not pass validation.');
        const candidates = await this.services.scheduling.getAvailableAppointments(
          {
            appointmentType: parsed.data.appointment_type,
            dates: parsed.data.dates,
            toolCallId: call.callId,
          },
          context,
        );
        return {
          execution: {
            callId: call.callId,
            name: call.name,
            status: 'succeeded',
            summary: `${candidates.length} appointment option(s) found.`,
          },
          handoffRequested: false,
          modelOutput: safeJson({ candidates }),
          sources: [],
        };
      }

      if (call.name === 'prepare_appointment_booking' && this.services.scheduling) {
        const parsed = prepareAppointmentBookingSchema.safeParse(rawArguments);
        if (!parsed.success) return rejected(call, 'Tool arguments did not pass validation.');
        const prepared = await this.services.scheduling.prepareAppointmentBooking(
          {
            candidateId: parsed.data.candidate_id,
            subjectName: parsed.data.subject_name ?? null,
            toolCallId: call.callId,
          },
          context,
        );
        return {
          execution: {
            callId: call.callId,
            name: call.name,
            status: 'succeeded',
            summary:
              prepared.outcome === 'ready'
                ? 'Booking is ready for confirmation.'
                : 'Booking could not be prepared.',
          },
          handoffRequested: false,
          modelOutput: safeJson(prepared),
          sources: [],
        };
      }

      if (call.name === 'book_appointment' && this.services.scheduling) {
        const parsed = bookAppointmentSchema.safeParse(rawArguments);
        if (!parsed.success) return rejected(call, 'Tool arguments did not pass validation.');
        const booked = await this.services.scheduling.bookAppointment(
          { bookingIntentId: parsed.data.booking_intent_id, toolCallId: call.callId },
          context,
        );
        return {
          execution: {
            callId: call.callId,
            name: call.name,
            status: booked.outcome === 'booked' ? 'succeeded' : 'failed',
            summary: `Booking outcome: ${booked.outcome}.`,
          },
          handoffRequested: booked.outcome === 'unknown',
          modelOutput: safeJson(booked),
          sources: [],
        };
      }

      const parsed = requestHumanHelpSchema.safeParse(rawArguments);
      if (!parsed.success) return rejected(call, 'Tool arguments did not pass validation.');
      const handoff = await this.services.requestHumanHelp(
        { ...parsed.data, toolCallId: call.callId },
        context,
      );
      if (!handoff.created) {
        return {
          execution: {
            callId: call.callId,
            name: call.name,
            status: 'failed',
            summary: 'Handoff was not created.',
          },
          handoffRequested: false,
          modelOutput: safeJson({
            ok: false,
            message: 'The team could not be notified automatically.',
          }),
          sources: [],
        };
      }
      return {
        execution: {
          callId: call.callId,
          name: call.name,
          status: 'succeeded',
          summary: 'Team handoff requested.',
        },
        handoffRequested: true,
        modelOutput: safeJson({ ok: true, requested: true, urgency: parsed.data.urgency }),
        sources: [],
      };
    } catch {
      return {
        execution: {
          callId: call.callId,
          name: call.name,
          status: 'failed',
          summary: 'Tool execution failed.',
        },
        handoffRequested: false,
        knowledgeOutcome: call.name === 'search_business_knowledge' ? 'failed' : undefined,
        modelOutput: safeJson({
          ok: false,
          message: 'The requested action could not be completed.',
        }),
        sources: [],
      };
    }
  }
}

/** Stable id for deterministic policy-initiated handoffs; repeated turns remain idempotent. */
export function policyHandoffCallId(context: AgentExecutionContext, message: string): string {
  const digest = createHash('sha256').update(`${context.conversationId}:${message}`).digest('hex');
  return `policy-${digest.slice(0, 48)}`;
}
