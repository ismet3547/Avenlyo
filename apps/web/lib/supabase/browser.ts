'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@avenlyo/database';

import { getSupabaseCredentials } from './config';

export function createBrowserSupabaseClient() {
  const credentials = getSupabaseCredentials();

  if (!credentials) {
    return null;
  }

  return createBrowserClient<Database>(credentials.url, credentials.anonKey);
}
