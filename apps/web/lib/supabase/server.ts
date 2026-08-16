import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { getSupabaseCredentials } from './config';

export async function createServerSupabaseClient() {
  const credentials = getSupabaseCredentials();

  if (!credentials) {
    return null;
  }

  const cookieStore = await cookies();

  return createServerClient(credentials.url, credentials.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(values) {
        try {
          values.forEach(({ name, options, value }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot write response cookies. Middleware will handle refresh later.
        }
      },
    },
  });
}
