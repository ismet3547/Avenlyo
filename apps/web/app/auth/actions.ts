'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { getSafeAuthError } from '@/lib/auth/errors';
import { authLinkWithNext, safeNextDestination } from '@/lib/auth/next-destination';
import type { FormActionState } from '@/lib/forms/state';
import { env } from '@/lib/supabase/config';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const credentialsSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least eight characters.'),
});

/**
 * Where to send the user once authenticated. Never trusted as given: an unsafe value is dropped
 * rather than corrected, so a crafted link cannot bounce a freshly signed-in user off-origin.
 */
function continuationFrom(formData: FormData): string {
  const requested = formData.get('next');
  const safe = safeNextDestination(typeof requested === 'string' ? requested : null);
  return safe ? `/auth/continue?next=${encodeURIComponent(safe)}` : '/auth/continue';
}

const signUpSchema = credentialsSchema
  .extend({ confirmPassword: z.string() })
  .refine((value) => value.password === value.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

function invalidState(error: z.ZodError): FormActionState {
  return {
    status: 'error',
    message: 'Check the highlighted fields and try again.',
    fieldErrors: error.flatten().fieldErrors,
  };
}

async function getApplicationOrigin(): Promise<string> {
  if (env.NEXT_PUBLIC_APP_URL) {
    return env.NEXT_PUBLIC_APP_URL;
  }

  const requestHeaders = await headers();
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host');
  const protocol = requestHeaders.get('x-forwarded-proto') ?? 'http';
  return host ? `${protocol}://${host}` : 'http://localhost:3000';
}

export async function signInAction(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const result = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!result.success) {
    return invalidState(result.error);
  }

  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { status: 'error', message: 'Supabase is not configured for this environment.' };
  }

  const { error } = await supabase.auth.signInWithPassword(result.data);
  if (error) {
    return { status: 'error', message: getSafeAuthError(error.code) };
  }

  // The continuation resolver decides where this account belongs; sign-in does not guess.
  redirect(continuationFrom(formData));
}

export async function signUpAction(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const result = signUpSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    confirmPassword: formData.get('confirmPassword'),
  });

  if (!result.success) {
    return invalidState(result.error);
  }

  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { status: 'error', message: 'Supabase is not configured for this environment.' };
  }

  const origin = await getApplicationOrigin();
  const requestedNext = formData.get('next');
  // Confirmation happens in a later request, possibly from a mail client, so the destination has to
  // survive in the callback URL. It is validated here and again when the callback runs.
  const callbackPath = authLinkWithNext(
    '/auth/callback',
    typeof requestedNext === 'string' ? requestedNext : null,
  );
  const { data, error } = await supabase.auth.signUp({
    email: result.data.email,
    password: result.data.password,
    options: { emailRedirectTo: `${origin}${callbackPath}` },
  });

  if (error) {
    return { status: 'error', message: getSafeAuthError(error.code) };
  }

  if (data.session) {
    redirect(continuationFrom(formData));
  }

  return {
    status: 'success',
    message: 'Check your email to confirm your account, then return here to sign in.',
  };
}

export async function signOutAction() {
  const supabase = await createServerSupabaseClient();
  await supabase?.auth.signOut();
  redirect('/auth/sign-in');
}
