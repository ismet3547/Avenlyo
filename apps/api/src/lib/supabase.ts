import { createSupabaseClient } from '@avenlyo/database';
import type { Database } from '@avenlyo/database';
import { createClient } from '@supabase/supabase-js';

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

/** Voice webhooks have no user JWT. This client is created only inside the Fastify backend. */
export function createVoiceServiceSupabaseClient() {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}
