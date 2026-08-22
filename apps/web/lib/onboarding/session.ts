import { redirect } from 'next/navigation';
import { cache } from 'react';

import { getRequiredAuthContext } from '@/lib/supabase/auth';

import {
  resolveWorkspace,
  type WorkspaceOption,
  type WorkspaceSelection,
} from '@/lib/workspace/selection';
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

export type CompletedWorkspaceResolution =
  | { readonly kind: 'redirect'; readonly to: string }
  | { readonly kind: 'context'; readonly context: TenantContext };

/**
 * Pure decision core of `requireCompletedWorkspace`.
 *
 * Extracted so the resolution logic -- match the stored preference against what the caller may
 * reach right now, then re-verify the exact selected location -- is unit-testable without mocking
 * `next/navigation`'s `redirect()`, which throws and never returns and so is treated as a boundary
 * here, not something to fake in a unit test. `loadContext` is injected for the same reason
 * `ensureSingleTenantContext` injects `loadContexts`: the database call stays a boundary the test
 * controls.
 */
export async function resolveCompletedWorkspaceContext(
  options: readonly WorkspaceOption[],
  selection: WorkspaceSelection | null,
  loadContext: (organizationId: string, locationId: string | null) => Promise<TenantContext | null>,
): Promise<CompletedWorkspaceResolution> {
  const resolution = resolveWorkspace(options, selection);

  if (resolution.kind === 'none') {
    return { kind: 'redirect', to: '/onboarding' };
  }

  if (resolution.kind === 'select') {
    return { kind: 'redirect', to: '/workspace/select' };
  }

  const selected = resolution.option;

  if (resolution.kind === 'onboarding') {
    return {
      kind: 'redirect',
      to: getOnboardingDestination({
        onboardingStatus: selected.onboardingStatus,
        onboardingStep: selected.onboardingStep,
      } as TenantContext),
    };
  }

  // The option proves authorization; this loads the full context for the exact selected location.
  const context = await loadContext(selected.organizationId, selected.locationId);

  if (!context) {
    // Authorized a moment ago and not now: re-resolve rather than serve a stale context.
    return { kind: 'redirect', to: '/workspace/select' };
  }

  if (context.onboardingStatus !== 'completed') {
    return { kind: 'redirect', to: getOnboardingDestination(context) };
  }

  return { kind: 'context', context };
}

/**
 * The single trusted context resolver every dashboard page runs through.
 *
 * Selection is centralized here rather than repeated per page, so no page ever decides which
 * organization it is looking at from a URL segment. The stored preference is matched against what
 * the database says the caller may reach on this request: a revoked membership, an unassigned
 * location, or a deleted location simply stops matching, and resolution starts again.
 *
 * Memoized per request with `cache()`: every dashboard page calls this, and within one render the
 * answer cannot change. A revoked membership or reassigned location still takes effect on the very
 * next request, because the memo is scoped to this render and nothing persists past it.
 */
export const requireCompletedWorkspace = cache(
  async function requireCompletedWorkspace(): Promise<TenantContext> {
    const auth = await getRequiredAuthContext();

    if (!auth) {
      redirect('/auth/sign-in');
    }

    const options = await loadWorkspaceOptions(auth.supabase);
    const resolution = await resolveCompletedWorkspaceContext(
      options,
      await readWorkspaceSelection(),
      (organizationId, locationId) =>
        loadWorkspaceContext(auth.supabase, organizationId, locationId),
    );

    if (resolution.kind === 'redirect') {
      redirect(resolution.to);
    }

    return resolution.context;
  },
);

/** The contexts this caller may switch between, for the dashboard shell affordance. */
export async function loadSwitchableWorkspaces() {
  const auth = await getRequiredAuthContext();
  if (!auth) return [];
  return loadWorkspaceOptions(auth.supabase);
}
