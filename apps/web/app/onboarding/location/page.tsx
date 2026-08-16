import { LocationForm } from '@/components/onboarding/location-form';
import { OnboardingShell } from '@/components/onboarding/onboarding-shell';
import { PageHeading } from '@/components/onboarding/page-heading';
import { getPersistedActiveStep } from '@/lib/onboarding/routing';
import { requireOnboardingStep } from '@/lib/onboarding/session';

export default async function LocationPage() {
  const context = await requireOnboardingStep('location');

  return (
    <OnboardingShell activeStep="location" persistedStep={getPersistedActiveStep(context)}>
      <PageHeading
        description="Set the address, timezone, and weekly hours for your first location. This structure is ready for multi-location businesses later."
        eyebrow="Step 3 of 5"
        title="Set up your primary location."
      />
      <LocationForm
        initialAddress={context.locationAddress}
        initialBusinessHours={context.businessHours}
        initialName={context.locationName}
        initialTimezone={context.locationTimezone}
      />
    </OnboardingShell>
  );
}
