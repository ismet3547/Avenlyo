import 'dotenv/config';

import { parseEnvironment } from '@avenlyo/shared';
import { z } from 'zod';

export const env = parseEnvironment(
  z.object({
    API_CORS_ORIGIN: z.string().url().default('http://localhost:3000'),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_PROJECT_ID: z.string().min(1).optional(),
    OPENAI_REALTIME_MODEL: z.literal('gpt-realtime-2.1').default('gpt-realtime-2.1'),
    OPENAI_WEBHOOK_SECRET: z.string().min(1).optional(),
    SUPABASE_ANON_KEY: z.string().min(1).optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
    SUPABASE_URL: z.string().url().optional(),
  }),
);

export const isSupabaseConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);

export const isVoiceRuntimeConfigured = Boolean(
  env.OPENAI_API_KEY &&
  env.OPENAI_WEBHOOK_SECRET &&
  env.SUPABASE_URL &&
  env.SUPABASE_SERVICE_ROLE_KEY,
);
