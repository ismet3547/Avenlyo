import 'dotenv/config';

import { parseEnvironment } from '@avenlyo/shared';
import { z } from 'zod';

export const env = parseEnvironment(
  z.object({
    API_CORS_ORIGIN: z.string().url().default('http://localhost:3000'),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SUPABASE_ANON_KEY: z.string().min(1).optional(),
    SUPABASE_URL: z.string().url().optional(),
  }),
);

export const isSupabaseConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
