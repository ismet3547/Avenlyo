import type { Database } from '@avenlyo/database';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

import { getSupabaseCredentials } from './config';

interface SupabaseCookie {
  name: string;
  options: CookieOptions;
  value: string;
}

export async function refreshSupabaseSession(request: NextRequest) {
  const credentials = getSupabaseCredentials();
  let response = NextResponse.next({ request });

  if (!credentials) {
    return response;
  }

  const supabase = createServerClient<Database>(credentials.url, credentials.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values: SupabaseCookie[]) {
        values.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        values.forEach(({ name, options, value }) => response.cookies.set(name, value, options));
      },
    },
  });

  await supabase.auth.getUser();
  return response;
}
