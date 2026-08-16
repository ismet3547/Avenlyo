import type { User } from '@supabase/supabase-js';

import { createServerSupabaseClient } from './server';

export async function getRequiredAuthContext() {
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

export async function getOptionalCurrentUser(): Promise<User | null> {
  return (await getRequiredAuthContext())?.user ?? null;
}
