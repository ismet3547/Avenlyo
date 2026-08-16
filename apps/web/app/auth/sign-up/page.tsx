import { redirect } from 'next/navigation';

import { signUpAction } from '@/app/auth/actions';
import { AuthForm } from '@/components/auth-form';
import { AuthShell } from '@/components/auth-shell';
import { getOptionalCurrentUser } from '@/lib/supabase/auth';

export default async function SignUpPage() {
  if (await getOptionalCurrentUser()) {
    redirect('/onboarding');
  }

  return (
    <AuthShell
      description="Create the owner account for your first workspace. You can invite staff in a later phase."
      title="Start with your front desk."
    >
      <AuthForm action={signUpAction} mode="sign-up" />
    </AuthShell>
  );
}
