import { redirect } from 'next/navigation';

import { getOnboardingDestination } from '@/lib/onboarding/routing';
import { requireOnboardingContext } from '@/lib/onboarding/session';

export default async function OnboardingPage() {
  const context = await requireOnboardingContext();
  redirect(getOnboardingDestination(context));
}
