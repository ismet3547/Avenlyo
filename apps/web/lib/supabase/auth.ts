import type { User } from '@supabase/supabase-js';

import { createServerSupabaseClient } from './server';

export async function getOptionalCurrentUser(): Promise<User | null> {
  const supabase = await createServerSupabaseClient();

  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase.auth.getUser();

  if (error) {
    return null;
  }

  return data.user;
}
