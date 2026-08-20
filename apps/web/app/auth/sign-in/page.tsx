import { redirect } from 'next/navigation';

import { signInAction } from '@/app/auth/actions';
import { AuthForm } from '@/components/auth-form';
import { AuthShell } from '@/components/auth-shell';
import { authLinkWithNext, safeNextDestination } from '@/lib/auth/next-destination';
import { getOptionalCurrentUser } from '@/lib/supabase/auth';

interface SignInPageProps {
  searchParams: Promise<{ error?: string; next?: string }>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const { error, next } = await searchParams;
  // Validated once, here, so nothing downstream renders or redirects to an unchecked destination.
  const safeNext = safeNextDestination(next);

  if (await getOptionalCurrentUser()) {
    // Someone already signed in who follows an invitation link still has an invitation to accept,
    // so this hands off to the shared continuation resolver rather than assuming onboarding.
    redirect(authLinkWithNext('/auth/continue', safeNext));
  }

  return (
    <AuthShell
      description="Use the email and password connected to your Avenlyo workspace."
      title="Welcome back."
    >
      {error === 'callback' ? (
        <p className="mt-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900">
          The confirmation link could not be completed. Request a new link or sign in again.
        </p>
      ) : null}
      <AuthForm action={signInAction} mode="sign-in" next={safeNext ?? undefined} />
    </AuthShell>
  );
}
