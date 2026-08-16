import { BusinessForm } from '@/components/onboarding/business-form';
import { OnboardingShell } from '@/components/onboarding/onboarding-shell';
import { PageHeading } from '@/components/onboarding/page-heading';
import { getPersistedActiveStep } from '@/lib/onboarding/routing';
import { requireOnboardingStep } from '@/lib/onboarding/session';

export default async function BusinessPage() {
  const context = await requireOnboardingStep('business');

  return (
    <OnboardingShell activeStep="business" persistedStep={getPersistedActiveStep(context)}>
      <PageHeading
        description="Add the details customers use to recognize and contact your business. You can leave the website and phone blank for now."
        eyebrow="Step 2 of 5"
        title="Tell us about the business."
      />
      <BusinessForm
        initialName={context.organizationName}
        initialPhone={context.businessPhone}
        initialWebsiteUrl={context.websiteUrl}
      />
    </OnboardingShell>
  );
}
