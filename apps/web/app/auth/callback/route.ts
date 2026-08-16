import { type NextRequest, NextResponse } from 'next/server';

import { createServerSupabaseClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const next = request.nextUrl.searchParams.get('next') ?? '/dashboard';
  const redirectUrl = request.nextUrl.clone();
  redirectUrl.pathname = next.startsWith('/') ? next : '/dashboard';
  redirectUrl.search = '';

  const supabase = await createServerSupabaseClient();

  if (code && supabase) {
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(redirectUrl);
}
