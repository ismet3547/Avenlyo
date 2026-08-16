import { createSupabaseClient } from '@avenlyo/database';

import { env } from '../env.js';

export function createApiSupabaseClient() {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return null;
  }

  return createSupabaseClient({
    url: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
  });
}
