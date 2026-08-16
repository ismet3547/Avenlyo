import { resolveIndustryPack } from '@avenlyo/industries';
import Link from 'next/link';

import { completeOnboardingAction } from '@/app/onboarding/actions';
import { OnboardingShell } from '@/components/onboarding/onboarding-shell';
import { PageHeading } from '@/components/onboarding/page-heading';
import { SingleActionForm } from '@/components/onboarding/single-action-form';
import { getPersistedActiveStep } from '@/lib/onboarding/routing';
import { requireOnboardingStep } from '@/lib/onboarding/session';

interface ReviewItemProps {
  children: React.ReactNode;
  editHref: string;
  label: string;
}

function ReviewItem({ children, editHref, label }: ReviewItemProps) {
  return (
    <div className="grid gap-3 py-5 sm:grid-cols-[9rem_1fr_auto] sm:items-start">
      <p className="font-utility text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <div className="text-sm leading-6 text-ink">{children}</div>
      <Link className="text-sm font-semibold text-primary hover:underline" href={editHref}>
        Edit
      </Link>
    </div>
  );
}

export default async function ReviewPage() {
  const context = await requireOnboardingStep('review');
  const industry = context.primaryIndustryId
    ? resolveIndustryPack(context.primaryIndustryId)
    : null;
  const address = context.locationAddress;
  const openDayCount = context.businessHours
    ? Object.values(context.businessHours).filter((day) => !day.closed).length
    : 0;

  return (
    <OnboardingShell activeStep="review" persistedStep={getPersistedActiveStep(context)}>
      <PageHeading
        description="Confirm the foundation for this workspace. Finishing saves the setup as complete; it does not activate messaging, voice, AI, or integrations."
        eyebrow="Step 5 of 5"
        title="Everything in the right place."
      />

      <div className="my-9 divide-y divide-slate-100 rounded-2xl border border-slate-200 px-5 sm:px-6">
        <ReviewItem editHref="/onboarding/industry" label="Industry">
          <p className="font-semibold">{industry?.name ?? 'Not selected'}</p>
          <p className="text-muted-foreground">{industry?.description}</p>
        </ReviewItem>
        <ReviewItem editHref="/onboarding/business" label="Business">
          <p className="font-semibold">{context.organizationName}</p>
          <p className="text-muted-foreground">
            {[context.websiteUrl, context.businessPhone].filter(Boolean).join(' · ') ||
              'No website or phone added'}
          </p>
        </ReviewItem>
        <ReviewItem editHref="/onboarding/location" label="Location">
          <p className="font-semibold">{context.locationName}</p>
          <p className="text-muted-foreground">
            {[address.street, address.city, address.region, address.postalCode, address.countryCode]
              .filter(Boolean)
              .join(', ')}
          </p>
          <p className="text-muted-foreground">
            {context.locationTimezone} · {openDayCount} days open
          </p>
        </ReviewItem>
        <ReviewItem editHref="/onboarding/business" label="Website source">
          <p className="font-semibold">{context.websiteUrl ? 'Ready to import' : 'Not provided'}</p>
          <p className="break-all text-muted-foreground">
            {context.websiteUrl ?? 'Business knowledge can be added manually later.'}
          </p>
        </ReviewItem>
      </div>

      <SingleActionForm
        action={completeOnboardingAction}
        fieldName="intent"
        fieldValue="complete"
        label="Finish setup"
        pendingLabel="Finishing…"
      />
    </OnboardingShell>
  );
}
