import type { TenantContext } from './types';

export const onboardingSteps = ['industry', 'business', 'location', 'website', 'review'] as const;
export type ActiveOnboardingStep = (typeof onboardingSteps)[number];

export const onboardingStepRoutes: Record<ActiveOnboardingStep, string> = {
  industry: '/onboarding/industry',
  business: '/onboarding/business',
  location: '/onboarding/location',
  website: '/onboarding/website',
  review: '/onboarding/review',
};

export type TenantResolution =
  | { kind: 'none' }
  | { context: TenantContext; kind: 'single' }
  | { contexts: readonly TenantContext[]; kind: 'multiple' };

export class MultipleWorkspacesError extends Error {
  public constructor() {
    super('Workspace selection is required for accounts with multiple organizations.');
    this.name = 'MultipleWorkspacesError';
  }
}

/**
 * The workspace this account is still setting up, if any.
 *
 * Only an owner reaches onboarding, and an owner has at most one workspace in progress. Someone who
 * owns an unfinished workspace and has also accepted an invitation elsewhere legitimately has two
 * contexts, and refusing to resolve that is what used to make onboarding unreachable for them.
 */
function findOnboardingContext(
  contexts: readonly TenantContext[],
): TenantContext | null {
  return (
    contexts.find(
      (candidate) => candidate.role === 'owner' && candidate.onboardingStatus !== 'completed',
    ) ?? null
  );
}

export function resolveTenantContexts(contexts: readonly TenantContext[]): TenantResolution {
  if (contexts.length === 0) {
    return { kind: 'none' };
  }

  if (contexts.length === 1) {
    const context = contexts[0];
    return context ? { context, kind: 'single' } : { kind: 'none' };
  }

  return { contexts, kind: 'multiple' };
}

export async function ensureSingleTenantContext(
  loadContexts: () => Promise<readonly TenantContext[]>,
  bootstrapWorkspace: () => Promise<void>,
): Promise<TenantContext> {
  let resolution = resolveTenantContexts(await loadContexts());

  if (resolution.kind === 'none') {
    await bootstrapWorkspace();
    resolution = resolveTenantContexts(await loadContexts());
  }

  if (resolution.kind === 'multiple') {
    // A workspace still being set up is the only thing onboarding can act on. Anything else means
    // this account has finished contexts and belongs in the selector, not here.
    const inProgress = findOnboardingContext(resolution.contexts);
    if (inProgress) return inProgress;
    throw new MultipleWorkspacesError();
  }

  if (resolution.kind === 'none') {
    throw new Error('Workspace bootstrap did not create a tenant context.');
  }

  return resolution.context;
}

export function getOnboardingDestination(context: TenantContext): string {
  if (context.onboardingStatus === 'completed') {
    return '/dashboard';
  }

  const step = context.onboardingStep;
  if (step && step !== 'completed') {
    return onboardingStepRoutes[step];
  }

  return onboardingStepRoutes.industry;
}

export function getPersistedActiveStep(context: TenantContext): ActiveOnboardingStep {
  const step = context.onboardingStep;
  return step && step !== 'completed' ? step : 'industry';
}

export function canVisitOnboardingStep(
  context: TenantContext,
  requestedStep: ActiveOnboardingStep,
): boolean {
  const currentStep = context.onboardingStep;

  if (context.onboardingStatus === 'completed' || currentStep === 'completed') {
    return false;
  }

  if (!currentStep) {
    return requestedStep === 'industry';
  }

  return onboardingSteps.indexOf(requestedStep) <= onboardingSteps.indexOf(currentStep);
}
