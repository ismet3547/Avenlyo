import { type NextRequest, NextResponse } from 'next/server';

import { authLinkWithNext } from '@/lib/auth/next-destination';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * Email confirmation lands here. It resolves nothing itself: the continuation route owns that one
 * decision, so sign-in and confirmation can never drift apart. The `next` parameter is revalidated
 * rather than trusted, because this URL travelled through an email client.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const supabase = await createServerSupabaseClient();

  if (!code || !supabase) {
    return NextResponse.redirect(new URL('/auth/sign-in?error=callback', request.url));
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  const destination = error
    ? '/auth/sign-in?error=callback'
    : authLinkWithNext('/auth/continue', request.nextUrl.searchParams.get('next'));
  return NextResponse.redirect(new URL(destination, request.url));
}
