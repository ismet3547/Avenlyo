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
        description="Avenlyo V1 is built for private dental clinics: patient questions, implant and cosmetic leads, appointments, follow-up and safe handoff to your team."
        eyebrow="Step 1 of 5"
        title="Set up your dental clinic"
      />
      <IndustryForm />
    </OnboardingShell>
  );
}
