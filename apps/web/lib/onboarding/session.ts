import { redirect } from 'next/navigation';

import { getRequiredAuthContext } from '@/lib/supabase/auth';

import { resolveWorkspace } from '@/lib/workspace/selection';
import { loadWorkspaceOptions, readWorkspaceSelection } from '@/lib/workspace/service';

import {
  canVisitOnboardingStep,
  getOnboardingDestination,
  type ActiveOnboardingStep,
} from './routing';
import { ensureWorkspaceContext, loadWorkspaceContext } from './service';
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

/**
 * The single trusted context resolver every dashboard page runs through.
 *
 * Selection is centralized here rather than repeated per page, so no page ever decides which
 * organization it is looking at from a URL segment. The stored preference is matched against what
 * the database says the caller may reach on this request: a revoked membership, an unassigned
 * location, or a deleted location simply stops matching, and resolution starts again.
 */
export async function requireCompletedWorkspace(): Promise<TenantContext> {
  const auth = await getRequiredAuthContext();

  if (!auth) {
    redirect('/auth/sign-in');
  }

  const options = await loadWorkspaceOptions(auth.supabase);
  const resolution = resolveWorkspace(options, await readWorkspaceSelection());

  if (resolution.kind === 'none') {
    redirect('/onboarding');
  }

  if (resolution.kind === 'select') {
    redirect('/workspace/select');
  }

  const selected = resolution.option;

  if (resolution.kind === 'onboarding') {
    redirect(
      getOnboardingDestination({
        onboardingStatus: selected.onboardingStatus,
        onboardingStep: selected.onboardingStep,
      } as TenantContext),
    );
  }

  // The option proves authorization; this loads the full context for the exact selected location.
  const context = await loadWorkspaceContext(
    auth.supabase,
    selected.organizationId,
    selected.locationId,
  );

  if (!context) {
    // Authorized a moment ago and not now: re-resolve rather than serve a stale context.
    redirect('/workspace/select');
  }

  if (context.onboardingStatus !== 'completed') {
    redirect(getOnboardingDestination(context));
  }

  return context;
}

/** The contexts this caller may switch between, for the dashboard shell affordance. */
export async function loadSwitchableWorkspaces() {
  const auth = await getRequiredAuthContext();
  if (!auth) return [];
  return loadWorkspaceOptions(auth.supabase);
}
