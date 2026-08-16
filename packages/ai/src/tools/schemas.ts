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
