import { z } from 'zod';

export const searchBusinessKnowledgeSchema = z
  .object({ query: z.string().trim().min(3).max(600) })
  .strict();

export const requestHumanHelpSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
    urgency: z.enum(['normal', 'urgent']),
  })
  .strict();

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
export const upcomingAppointmentsSchema = z.object({}).strict();
export const rescheduleOptionsSchema = z.object({ appointment_reference: z.string().uuid(), dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(14) }).strict();
export const prepareAppointmentRescheduleSchema = z.object({ candidate_id: z.string().uuid() }).strict();
export const prepareAppointmentCancellationSchema = z.object({ appointment_reference: z.string().uuid() }).strict();
export const appointmentChangeExecutionSchema = z.object({ change_intent_id: z.string().uuid() }).strict();

export const searchBusinessKnowledgeFunction = {
  description:
    'Search approved, published business knowledge for a factual business-specific customer question.',
  name: 'search_business_knowledge',
  parameters: {
    additionalProperties: false,
    properties: {
      query: { description: 'The concise factual question to search for.', type: 'string' },
    },
    required: ['query'],
    type: 'object',
  },
  strict: true,
} as const;

export const requestHumanHelpFunction = {
  description:
    'Flag a conversation for the business team when human help or urgent escalation is needed.',
  name: 'request_human_help',
  parameters: {
    additionalProperties: false,
    properties: {
      reason: { description: 'A concise operational reason for the handoff.', type: 'string' },
      urgency: { enum: ['normal', 'urgent'], type: 'string' },
    },
    required: ['reason', 'urgency'],
    type: 'object',
  },
  strict: true,
} as const;

export const getAvailableAppointmentsFunction = {
  description: 'Find bookable appointment options for requested dates. Never infer availability.',
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
} as const;
export const prepareAppointmentBookingFunction = {
  description: 'Prepare one offered appointment option. This does not book an appointment.',
  name: 'prepare_appointment_booking',
  parameters: {
    additionalProperties: false,
    properties: { candidate_id: { type: 'string' }, subject_name: { type: 'string' } },
    required: ['candidate_id'],
    type: 'object',
  },
  strict: true,
} as const;
export const bookAppointmentFunction = {
  description:
    'Book a prepared option only when the current customer message explicitly confirms it.',
  name: 'book_appointment',
  parameters: {
    additionalProperties: false,
    properties: { booking_intent_id: { type: 'string' } },
    required: ['booking_intent_id'],
    type: 'object',
  },
  strict: true,
} as const;
function lifecycleFunction(name: string, description: string, properties: Record<string, unknown>, required: readonly string[]) {
  return { description, name, parameters: { additionalProperties: false, properties, required, type: 'object' }, strict: true } as const;
}
export const getUpcomingAppointmentsFunction = lifecycleFunction('get_upcoming_appointments', 'List only the caller’s safely authorized upcoming appointments.', {}, []);
export const getRescheduleOptionsFunction = lifecycleFunction('get_reschedule_options', 'Find safe reschedule options for one opaque appointment reference.', { appointment_reference: { type: 'string' }, dates: { type: 'array', items: { type: 'string' } } }, ['appointment_reference', 'dates']);
export const prepareAppointmentRescheduleFunction = lifecycleFunction('prepare_appointment_reschedule', 'Prepare one offered reschedule option. This does not change the appointment.', { candidate_id: { type: 'string' } }, ['candidate_id']);
export const prepareAppointmentCancellationFunction = lifecycleFunction('prepare_appointment_cancellation', 'Prepare cancellation for one opaque appointment reference. This does not cancel it.', { appointment_reference: { type: 'string' } }, ['appointment_reference']);
export const rescheduleAppointmentFunction = lifecycleFunction('reschedule_appointment', 'Execute a prepared reschedule only after the current customer message explicitly confirms it.', { change_intent_id: { type: 'string' } }, ['change_intent_id']);
export const cancelAppointmentFunction = lifecycleFunction('cancel_appointment', 'Execute a prepared cancellation only after the current customer message explicitly confirms cancellation.', { change_intent_id: { type: 'string' } }, ['change_intent_id']);
