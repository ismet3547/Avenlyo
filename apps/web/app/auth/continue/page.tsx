import { redirect } from 'next/navigation';

import { safeNextDestination } from '@/lib/auth/next-destination';
import { getOnboardingDestination } from '@/lib/onboarding/routing';
import { getRequiredAuthContext } from '@/lib/supabase/auth';
import { resolveWorkspace } from '@/lib/workspace/selection';
import { loadWorkspaceOptions, readWorkspaceSelection } from '@/lib/workspace/service';

/**
 * The single post-authentication decision point.
 *
 * Sign-in, sign-up, and the email confirmation callback all land here instead of guessing a
 * destination. Previously every one of them redirected to /onboarding, which was wrong for an
 * invited person (they have no workspace to create), wrong for an existing member (they already
 * finished), and wrong for anyone with more than one workspace.
 */
interface ContinuePageProps {
  readonly searchParams: Promise<{ next?: string }>;
}

export default async function AuthContinuePage({ searchParams }: ContinuePageProps) {
  const auth = await getRequiredAuthContext();
  if (!auth) {
    redirect('/auth/sign-in');
  }

  // An invitation must be accepted before anything else, or a brand new invited user would be sent
  // to onboarding and bootstrap a personal workspace they never wanted.
  const { next } = await searchParams;
  const destination = safeNextDestination(next);
  if (destination) {
    redirect(destination);
  }

  const options = await loadWorkspaceOptions(auth.supabase);
  const resolution = resolveWorkspace(options, await readWorkspaceSelection());

  if (resolution.kind === 'none') {
    redirect('/onboarding');
  }
  if (resolution.kind === 'select') {
    redirect('/workspace/select');
  }
  if (resolution.kind === 'onboarding') {
    redirect(
      getOnboardingDestination({
        onboardingStatus: resolution.option.onboardingStatus,
        onboardingStep: resolution.option.onboardingStep,
      } as never),
    );
  }

  redirect('/dashboard');
}
