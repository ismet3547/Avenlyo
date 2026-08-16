import { redirect } from 'next/navigation';

import { signInAction } from '@/app/auth/actions';
import { AuthForm } from '@/components/auth-form';
import { AuthShell } from '@/components/auth-shell';
import { getOptionalCurrentUser } from '@/lib/supabase/auth';

interface SignInPageProps {
  searchParams: Promise<{ error?: string }>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  if (await getOptionalCurrentUser()) {
    redirect('/onboarding');
  }

  const { error } = await searchParams;

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
      <AuthForm action={signInAction} mode="sign-in" />
    </AuthShell>
  );
}
