import { IndustryForm } from '@/components/onboarding/industry-form';
import { OnboardingShell } from '@/components/onboarding/onboarding-shell';
import { PageHeading } from '@/components/onboarding/page-heading';
import { getPersistedActiveStep } from '@/lib/onboarding/routing';
import { requireOnboardingStep } from '@/lib/onboarding/session';

export default async function IndustryPage() {
  const context = await requireOnboardingStep('industry');

  return (
    <OnboardingShell activeStep="industry" persistedStep={getPersistedActiveStep(context)}>
      <PageHeading
        description="Choose the pack that best matches how your front desk works today. This sets a maintainable starting configuration; it does not activate an AI agent."
        eyebrow="Step 1 of 5"
        title="What kind of business are you setting up?"
      />
      <IndustryForm selectedIndustryId={context.primaryIndustryId} />
    </OnboardingShell>
  );
}
