import { redirect } from 'next/navigation';

import { signUpAction } from '@/app/auth/actions';
import { AuthForm } from '@/components/auth-form';
import { AuthShell } from '@/components/auth-shell';
import { authLinkWithNext, safeNextDestination } from '@/lib/auth/next-destination';
import { getOptionalCurrentUser } from '@/lib/supabase/auth';

interface SignUpPageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const { next } = await searchParams;
  const safeNext = safeNextDestination(next);
  const invited = safeNext?.startsWith('/invite/') ?? false;

  if (await getOptionalCurrentUser()) {
    redirect(authLinkWithNext('/auth/continue', safeNext));
  }

  return (
    <AuthShell
      description={
        invited
          ? 'Create your account with the email address the invitation was sent to.'
          : 'Create the owner account for your first workspace, then invite your team from Settings.'
      }
      title={invited ? 'Join your team.' : 'Start with your front desk.'}
    >
      <AuthForm action={signUpAction} mode="sign-up" next={safeNext ?? undefined} />
    </AuthShell>
  );
}
