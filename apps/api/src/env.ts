import 'dotenv/config';

import { parseEnvironment } from '@avenlyo/shared';
import { z } from 'zod';

export const env = parseEnvironment(
  z.object({
    API_CORS_ORIGIN: z.string().url().default('http://localhost:3000'),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    EZYVET_PARTNER_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_AGENT_MODEL: z.string().min(1).default('gpt-5.6'),
    OPENAI_PROJECT_ID: z.string().min(1).optional(),
    OPENAI_REALTIME_MODEL: z.literal('gpt-realtime-2.1').default('gpt-realtime-2.1'),
    OPENAI_WEBHOOK_SECRET: z.string().min(1).optional(),
    SUPABASE_ANON_KEY: z.string().min(1).optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
    SUPABASE_URL: z.string().url().optional(),
    TWILIO_ACCOUNT_SID: z
      .string()
      .regex(/^AC[a-zA-Z0-9]{32}$/)
      .optional(),
    TWILIO_AUTH_TOKEN: z.string().min(16).optional(),
    TWILIO_MESSAGING_WEBHOOK_BASE_URL: z.string().url().optional(),
    WEB_CHAT_IFRAME_ORIGIN: z.string().url().default('http://localhost:3000'),
  }),
);

if (
  env.NODE_ENV === 'production' &&
  env.TWILIO_MESSAGING_WEBHOOK_BASE_URL &&
  !env.TWILIO_MESSAGING_WEBHOOK_BASE_URL.startsWith('https://')
) {
  throw new Error('TWILIO_MESSAGING_WEBHOOK_BASE_URL must use HTTPS in production.');
}

if (env.NODE_ENV === 'production' && !env.WEB_CHAT_IFRAME_ORIGIN.startsWith('https://')) {
  throw new Error('WEB_CHAT_IFRAME_ORIGIN must use HTTPS in production.');
}

export const isSupabaseConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);

export const isVoiceRuntimeConfigured = Boolean(
  env.OPENAI_API_KEY &&
  env.OPENAI_WEBHOOK_SECRET &&
  env.SUPABASE_URL &&
  env.SUPABASE_SERVICE_ROLE_KEY,
);

export const isEzyVetRuntimeConfigured = Boolean(
  env.EZYVET_PARTNER_ID && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY,
);

export const isGoogleCalendarRuntimeConfigured = Boolean(
  env.GOOGLE_CLIENT_ID &&
  env.GOOGLE_CLIENT_SECRET &&
  env.GOOGLE_OAUTH_REDIRECT_URI &&
  env.SUPABASE_URL &&
  env.SUPABASE_SERVICE_ROLE_KEY,
);

export const isTwilioMessagingConfigured = Boolean(
  env.TWILIO_ACCOUNT_SID &&
  env.TWILIO_AUTH_TOKEN &&
  env.TWILIO_MESSAGING_WEBHOOK_BASE_URL &&
  env.SUPABASE_URL &&
  env.SUPABASE_SERVICE_ROLE_KEY,
);
