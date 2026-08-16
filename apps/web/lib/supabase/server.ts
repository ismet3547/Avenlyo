import { createServerClient } from '@supabase/ssr';
import type { Database } from '@avenlyo/database';
import { cookies } from 'next/headers';

import { getSupabaseCredentials } from './config';

export async function createServerSupabaseClient() {
  const credentials = getSupabaseCredentials();

  if (!credentials) {
    return null;
  }

  const cookieStore = await cookies();

  return createServerClient<Database>(credentials.url, credentials.anonKey, {
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

export type AvenlyoSupabaseClient = NonNullable<
  Awaited<ReturnType<typeof createServerSupabaseClient>>
>;
