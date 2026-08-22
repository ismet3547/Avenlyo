import { cache } from 'react';
import type { User } from '@supabase/supabase-js';

import { createServerSupabaseClient } from './server';

/**
 * Uncached auth resolution: null when Supabase isn't configured, null on an invalid or expired
 * session, the trusted context otherwise. Exported separately from `getRequiredAuthContext` so
 * this behavior is unit-testable without React's per-request cache dispatcher, which only
 * memoizes inside an active Server Component render and is a silent no-op anywhere else.
 */
export async function resolveAuthContext() {
  const supabase = await createServerSupabaseClient();

  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    return null;
  }

  return { supabase, user: data.user };
}

/**
 * The trusted API every layout, page, and action calls to resolve the caller. `auth.getUser()`
 * re-verifies the session against Supabase Auth on every call -- a real network round trip, not
 * a local JWT decode -- so this memoizes the resolution for the lifetime of one server render
 * with React's request-scoped `cache()`. The memo resets on the next request and is never shared
 * across users or requests: a new render always re-verifies from scratch.
 */
export const getRequiredAuthContext = cache(resolveAuthContext);

export async function getOptionalCurrentUser(): Promise<User | null> {
  return (await getRequiredAuthContext())?.user ?? null;
}
