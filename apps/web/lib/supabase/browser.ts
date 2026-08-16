'use client';

import { createBrowserClient } from '@supabase/ssr';

import { getSupabaseCredentials } from './config';

export function createBrowserSupabaseClient() {
  const credentials = getSupabaseCredentials();

  if (!credentials) {
    return null;
  }

  return createBrowserClient(credentials.url, credentials.anonKey);
}
