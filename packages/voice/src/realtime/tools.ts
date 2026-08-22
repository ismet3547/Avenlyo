import {
  captureLeadFunction,
  captureLeadSchema,
  reliableKnowledgeSources,
  requestHumanHelpFunction,
  requestHumanHelpSchema,
  searchBusinessKnowledgeFunction,
  searchBusinessKnowledgeSchema,
} from '@avenlyo/ai';
import type { KnowledgeSource } from '@avenlyo/ai';
import { requiresUrgentLeadHandoff, type IndustryPack } from '@avenlyo/industries';
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
export const appointmentReferenceSchema = z
  .object({ appointment_reference: z.string().uuid() })
  .strict();
export const rescheduleOptionsSchema = z
  .object({
    appointment_reference: z.string().uuid(),
    dates: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .min(1)
      .max(14),
  })
  .strict();
export const appointmentCandidateSchema = z.object({ candidate_id: z.string().uuid() }).strict();
export const appointmentIntentSchema = z.object({ change_intent_id: z.string().uuid() }).strict();
export const prepareSmsFollowupConsentSchema = z.object({}).strict();
export const confirmSmsFollowupConsentSchema = z
  .object({ consent_intent_id: z.string().uuid() })
  .strict();

const prepareSmsFollowupConsentFunction: VoiceFunctionTool = {
  description:
    'Prepare an optional SMS follow-up consent request for this exact caller before asking the consent question. Then ask whether they would like a text follow-up, wait for a new caller transcript, and only then use the confirmation tool for a clear yes. Never ask for or provide a phone number.',
  name: 'prepare_sms_followup_consent',
  parameters: { additionalProperties: false, properties: {}, required: [], type: 'object' },
  strict: true,
};
const confirmSmsFollowupConsentFunction: VoiceFunctionTool = {
  description:
    'Record consent only after the caller gives a later, clear yes in a new transcript after the follow-up question. Use the opaque consent intent returned by preparation; never supply a phone number or transcript.',
  name: 'confirm_sms_followup_consent',
  parameters: {
    additionalProperties: false,
    properties: { consent_intent_id: { type: 'string' } },
    required: ['consent_intent_id'],
    type: 'object',
  },
  strict: true,
};

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

function lifecycleFunction(
  name: Extract<
    VoiceFunctionTool['name'],
    | 'get_upcoming_appointments'
    | 'get_reschedule_options'
    | 'prepare_appointment_reschedule'
    | 'prepare_appointment_cancellation'
    | 'reschedule_appointment'
    | 'cancel_appointment'
  >,
  description: string,
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): VoiceFunctionTool {
  return {
    description,
    name,
    parameters: { additionalProperties: false, properties, required, type: 'object' },
    strict: true,
  };
}

const getUpcomingAppointmentsFunction = lifecycleFunction(
  'get_upcoming_appointments',
  "List only the caller's verified upcoming appointments for this exact active call.",
  {},
);
const getRescheduleOptionsFunction = lifecycleFunction(
  'get_reschedule_options',
  'Find replacement slots for one verified appointment. This does not change it.',
  {
    appointment_reference: { type: 'string' },
    dates: { items: { type: 'string' }, type: 'array' },
  },
  ['appointment_reference', 'dates'],
);
const prepareAppointmentRescheduleFunction = lifecycleFunction(
  'prepare_appointment_reschedule',
  'Prepare one offered replacement time. Ask for an explicit yes before executing.',
  { candidate_id: { type: 'string' } },
  ['candidate_id'],
);
const prepareAppointmentCancellationFunction = lifecycleFunction(
  'prepare_appointment_cancellation',
  'Prepare cancellation for one verified appointment. Ask for an explicit cancellation confirmation before executing.',
  { appointment_reference: { type: 'string' } },
  ['appointment_reference'],
);
const rescheduleAppointmentFunction = lifecycleFunction(
  'reschedule_appointment',
  "Execute only a prepared reschedule after the caller's current exact transcript explicitly confirms it.",
  { change_intent_id: { type: 'string' } },
  ['change_intent_id'],
);
const cancelAppointmentFunction = lifecycleFunction(
  'cancel_appointment',
  "Execute only a prepared cancellation after the caller's current exact transcript explicitly confirms it.",
  { change_intent_id: { type: 'string' } },
  ['change_intent_id'],
);

function baseTool(
  tool:
    | typeof searchBusinessKnowledgeFunction
    | typeof requestHumanHelpFunction
    | typeof captureLeadFunction,
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
  if (input.industry.allowedActions.includes('capture_lead'))
    tools.push(baseTool(captureLeadFunction));
  tools.push(prepareSmsFollowupConsentFunction, confirmSmsFollowupConsentFunction);
  if (input.transferEnabled && input.industry.allowedActions.includes('handoff_to_human')) {
    tools.push(transferCallFunction);
  }
  if (input.schedulingEnabled) {
    tools.push(
      getAvailableAppointmentsFunction,
      prepareAppointmentBookingFunction,
      bookAppointmentFunction,
      getUpcomingAppointmentsFunction,
      getRescheduleOptionsFunction,
      prepareAppointmentRescheduleFunction,
      prepareAppointmentCancellationFunction,
      rescheduleAppointmentFunction,
      cancelAppointmentFunction,
    );
  }
  return tools;
}

export interface VoiceToolServices {
  readonly followupConsent?: {
    confirm(
      input: {
        readonly consentIntentId: string;
        readonly triggeringInboundMessageId: string | null;
      },
      context: VoiceCallContext,
    ): Promise<{ readonly granted: boolean }>;
    prepare(
      input: { readonly triggeringInboundMessageId: string | null },
      context: VoiceCallContext,
    ): Promise<{ readonly consentIntentId: string; readonly expiresAt: string }>;
  };
  readonly leadCapture?: {
    capture(
      input: {
        readonly customerGoal?: 'appointment' | 'estimate' | 'information' | 'service';
        readonly customerName?: string;
        readonly details: Readonly<Record<string, string>>;
        readonly serviceCategory?: string;
        readonly toolCallId: string;
        readonly triggeringInboundMessageId: string | null;
        readonly urgency: 'routine' | 'soon' | 'urgent' | 'unknown';
      },
      context: VoiceCallContext,
    ): Promise<{
      readonly missingFields: readonly string[];
      readonly state:
        | 'billing_unavailable'
        | 'needs_human'
        | 'needs_more_information'
        | 'needs_clarification'
        | 'qualified';
    }>;
  };
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

/**
 * Voice trusts knowledge on exactly the terms chat does.
 *
 * This used to be a second copy of the filter, sharing only the threshold constant. Two copies of
 * a trust rule is one rule and one latent divergence: the calibration fix would have landed on
 * chat alone and left the phone answering "I don't have reliable information about that" to a
 * question the chat agent had just answered from the same published pages.
 */
const reliableSources = reliableKnowledgeSources;

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
      if (call.name === 'prepare_sms_followup_consent' && this.services.followupConsent) {
        const parsed = prepareSmsFollowupConsentSchema.safeParse(rawArguments);
        if (!parsed.success)
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        const consent = await this.services.followupConsent.prepare(
          { triggeringInboundMessageId: call.triggeringInboundMessageId ?? null },
          this.context,
        );
        return this.store(call.callId, {
          handoffRequested: false,
          modelOutput: output({
            consent_intent_id: consent.consentIntentId,
            expires_at: consent.expiresAt,
          }),
          status: 'succeeded',
          summary: 'SMS follow-up consent is ready for confirmation.',
          transferred: false,
        });
      }
      if (call.name === 'confirm_sms_followup_consent' && this.services.followupConsent) {
        const parsed = confirmSmsFollowupConsentSchema.safeParse(rawArguments);
        if (!parsed.success)
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        const consent = await this.services.followupConsent.confirm(
          {
            consentIntentId: parsed.data.consent_intent_id,
            triggeringInboundMessageId: call.triggeringInboundMessageId ?? null,
          },
          this.context,
        );
        return this.store(call.callId, {
          handoffRequested: false,
          modelOutput: output({ granted: consent.granted }),
          status: 'succeeded',
          summary: consent.granted
            ? 'SMS follow-up consent granted.'
            : 'SMS follow-up consent not granted.',
          transferred: false,
        });
      }
      if (call.name === 'capture_lead' && this.services.leadCapture) {
        const parsed = captureLeadSchema.safeParse(rawArguments);
        if (!parsed.success)
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        const lead = await this.services.leadCapture.capture(
          {
            ...(parsed.data.customerGoal ? { customerGoal: parsed.data.customerGoal } : {}),
            ...(parsed.data.customerName ? { customerName: parsed.data.customerName } : {}),
            details: parsed.data.details,
            ...(parsed.data.serviceCategory
              ? { serviceCategory: parsed.data.serviceCategory }
              : {}),
            toolCallId: call.callId,
            triggeringInboundMessageId: call.triggeringInboundMessageId ?? null,
            urgency: parsed.data.urgency,
          },
          this.context,
        );
        // Lead capture entitlement is unavailable, so nothing was persisted. Billing is an
        // organization configuration issue, never a customer escalation, so no handoff is raised
        // and the model is told only that the tool is unavailable.
        if (lead.state === 'billing_unavailable') {
          return this.store(call.callId, rejected('Lead capture is unavailable right now.'));
        }
        // A conflict intentionally remains needs_clarification. The trusted industry pack,
        // not the model-visible persistence result, determines urgent review.
        const handoffRequested = requiresUrgentLeadHandoff(
          this.context.industry,
          parsed.data.urgency,
        );
        if (handoffRequested) {
          await this.services.requestHumanHelp(
            {
              reason: 'An urgent lead needs a team follow-up.',
              toolCallId: `${call.callId}:urgent-lead`,
              urgency: 'urgent',
            },
            this.context,
          );
        }
        return this.store(call.callId, {
          handoffRequested,
          modelOutput: output({ missingFields: lead.missingFields, state: lead.state }),
          status: 'succeeded',
          summary: `Lead capture outcome: ${lead.state}.`,
          transferred: false,
        });
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
            triggeringInboundMessageId: call.triggeringInboundMessageId ?? null,
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
      if (
        this.schedulingEnabled &&
        this.services.scheduling?.getUpcomingAppointments &&
        call.name === 'get_upcoming_appointments'
      ) {
        if (call.schedulingBlocked)
          return this.store(call.callId, rejected('Scheduling is blocked for this call.'));
        if (!z.object({}).strict().safeParse(rawArguments).success)
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        const appointments = await this.services.scheduling.getUpcomingAppointments(
          {
            triggeringInboundMessageId: call.triggeringInboundMessageId ?? null,
            toolCallId: call.callId,
          },
          this.context,
        );
        return this.store(call.callId, {
          handoffRequested: false,
          modelOutput: output({ appointments }),
          status: 'succeeded',
          summary: `${appointments.length} upcoming appointment(s) found.`,
          transferred: false,
        });
      }
      if (
        this.schedulingEnabled &&
        this.services.scheduling?.getRescheduleOptions &&
        call.name === 'get_reschedule_options'
      ) {
        if (call.schedulingBlocked)
          return this.store(call.callId, rejected('Scheduling is blocked for this call.'));
        const parsed = rescheduleOptionsSchema.safeParse(rawArguments);
        if (!parsed.success)
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        const candidates = await this.services.scheduling.getRescheduleOptions(
          {
            appointmentReference: parsed.data.appointment_reference,
            dates: parsed.data.dates,
            triggeringInboundMessageId: call.triggeringInboundMessageId ?? null,
            toolCallId: call.callId,
          },
          this.context,
        );
        return this.store(call.callId, {
          handoffRequested: false,
          modelOutput: output({ candidates }),
          status: 'succeeded',
          summary: `${candidates.length} reschedule option(s) found.`,
          transferred: false,
        });
      }
      if (
        this.schedulingEnabled &&
        this.services.scheduling?.prepareAppointmentReschedule &&
        this.services.scheduling.prepareAppointmentCancellation &&
        (call.name === 'prepare_appointment_reschedule' ||
          call.name === 'prepare_appointment_cancellation')
      ) {
        if (call.schedulingBlocked)
          return this.store(call.callId, rejected('Scheduling is blocked for this call.'));
        const prepared =
          call.name === 'prepare_appointment_reschedule'
            ? await (async () => {
                const parsed = appointmentCandidateSchema.safeParse(rawArguments);
                return parsed.success
                  ? this.services.scheduling!.prepareAppointmentReschedule!(
                      {
                        candidateId: parsed.data.candidate_id,
                        triggeringInboundMessageId: call.triggeringInboundMessageId ?? null,
                        toolCallId: call.callId,
                      },
                      this.context,
                    )
                  : null;
              })()
            : await (async () => {
                const parsed = appointmentReferenceSchema.safeParse(rawArguments);
                return parsed.success
                  ? this.services.scheduling!.prepareAppointmentCancellation!(
                      {
                        appointmentReference: parsed.data.appointment_reference,
                        triggeringInboundMessageId: call.triggeringInboundMessageId ?? null,
                        toolCallId: call.callId,
                      },
                      this.context,
                    )
                  : null;
              })();
        if (!prepared)
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        return this.store(call.callId, {
          handoffRequested: false,
          modelOutput: output(prepared),
          status: prepared.outcome === 'ready' ? 'succeeded' : 'failed',
          summary:
            prepared.outcome === 'ready'
              ? 'Appointment change is ready for explicit confirmation.'
              : 'Appointment change could not be prepared.',
          transferred: false,
        });
      }
      if (
        this.schedulingEnabled &&
        this.services.scheduling?.executeAppointmentChange &&
        (call.name === 'reschedule_appointment' || call.name === 'cancel_appointment')
      ) {
        if (call.schedulingBlocked)
          return this.store(call.callId, rejected('Scheduling is blocked for this call.'));
        const parsed = appointmentIntentSchema.safeParse(rawArguments);
        if (!parsed.success)
          return this.store(call.callId, rejected('Tool arguments did not pass validation.'));
        const result = await this.services.scheduling.executeAppointmentChange(
          {
            changeIntentId: parsed.data.change_intent_id,
            triggeringInboundMessageId: call.triggeringInboundMessageId ?? null,
            toolCallId: call.callId,
          },
          this.context,
        );
        return this.store(call.callId, {
          handoffRequested: result.outcome === 'handoff_required' || result.outcome === 'unknown',
          modelOutput: output(result),
          status: result.outcome === 'completed' ? 'succeeded' : 'failed',
          summary: `Appointment change outcome: ${result.outcome}.`,
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
