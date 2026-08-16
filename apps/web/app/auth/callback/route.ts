import { type NextRequest, NextResponse } from 'next/server';

import { createServerSupabaseClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const supabase = await createServerSupabaseClient();

  if (!code || !supabase) {
    return NextResponse.redirect(new URL('/auth/sign-in?error=callback', request.url));
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  const destination = error ? '/auth/sign-in?error=callback' : '/onboarding';
  return NextResponse.redirect(new URL(destination, request.url));
}
