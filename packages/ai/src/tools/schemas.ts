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
