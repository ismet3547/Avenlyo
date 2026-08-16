import { redirect } from 'next/navigation';

import { getRequiredAuthContext } from '@/lib/supabase/auth';

import {
  canVisitOnboardingStep,
  getOnboardingDestination,
  resolveTenantContexts,
  type ActiveOnboardingStep,
} from './routing';
import { ensureWorkspaceContext, loadTenantContexts } from './service';
import type { TenantContext } from './types';

export async function requireOnboardingContext(): Promise<TenantContext> {
  const auth = await getRequiredAuthContext();

  if (!auth) {
    redirect('/auth/sign-in');
  }

  const context = await ensureWorkspaceContext(auth.supabase);
  if (context.onboardingStatus === 'completed') {
    redirect('/dashboard');
  }

  return context;
}

export async function requireOnboardingStep(
  requestedStep: ActiveOnboardingStep,
): Promise<TenantContext> {
  const context = await requireOnboardingContext();

  if (!canVisitOnboardingStep(context, requestedStep)) {
    redirect(getOnboardingDestination(context));
  }

  return context;
}

export async function requireCompletedWorkspace(): Promise<TenantContext> {
  const auth = await getRequiredAuthContext();

  if (!auth) {
    redirect('/auth/sign-in');
  }

  const resolution = resolveTenantContexts(await loadTenantContexts(auth.supabase));

  if (resolution.kind === 'none') {
    redirect('/onboarding');
  }

  if (resolution.kind === 'multiple') {
    throw new Error('Workspace selection is not available yet.');
  }

  if (resolution.context.onboardingStatus !== 'completed') {
    redirect(getOnboardingDestination(resolution.context));
  }

  return resolution.context;
}
