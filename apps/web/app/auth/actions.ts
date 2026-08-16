'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { getSafeAuthError } from '@/lib/auth/errors';
import type { FormActionState } from '@/lib/forms/state';
import { env } from '@/lib/supabase/config';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const credentialsSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least eight characters.'),
});

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

  redirect('/onboarding');
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
  const { data, error } = await supabase.auth.signUp({
    email: result.data.email,
    password: result.data.password,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });

  if (error) {
    return { status: 'error', message: getSafeAuthError(error.code) };
  }

  if (data.session) {
    redirect('/onboarding');
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
