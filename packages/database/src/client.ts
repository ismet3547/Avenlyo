import { createClient } from '@supabase/supabase-js';

export interface SupabaseClientCredentials {
  url: string;
  anonKey: string;
}

/**
 * Creates a request-safe client with persistence disabled. Each application validates and supplies
 * credentials at its boundary so this package never reads environment variables itself.
 */
export function createSupabaseClient(credentials: SupabaseClientCredentials) {
  return createClient(credentials.url, credentials.anonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
