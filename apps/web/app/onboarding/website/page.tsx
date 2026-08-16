import { Globe2 } from 'lucide-react';

import { continueWebsiteAction } from '@/app/onboarding/actions';
import { OnboardingShell } from '@/components/onboarding/onboarding-shell';
import { PageHeading } from '@/components/onboarding/page-heading';
import { SingleActionForm } from '@/components/onboarding/single-action-form';
import { getPersistedActiveStep } from '@/lib/onboarding/routing';
import { requireOnboardingStep } from '@/lib/onboarding/session';

export default async function WebsitePage() {
  const context = await requireOnboardingStep('website');

  return (
    <OnboardingShell activeStep="website" persistedStep={getPersistedActiveStep(context)}>
      <PageHeading
        description="Review what will be available for a future knowledge import. No website content is fetched during this phase."
        eyebrow="Step 4 of 5"
        title="Preview your website source."
      />

      <div className="my-9 rounded-2xl border border-slate-200 bg-slate-50/70 p-6">
        <Globe2 aria-hidden="true" className="size-6 text-primary" />
        {context.websiteUrl ? (
          <>
            <p className="mt-4 text-sm leading-6 text-ink">
              We&apos;ll use your website to help configure Avenlyo.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <div>
                <p className="font-utility text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Website
                </p>
                <p className="mt-1 break-all text-sm font-medium text-ink">{context.websiteUrl}</p>
              </div>
              <span className="w-fit rounded-full bg-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-900">
                Ready to import
              </span>
            </div>
          </>
        ) : (
          <p className="mt-4 text-sm leading-6 text-ink">
            You can add business knowledge manually later.
          </p>
        )}
      </div>

      <SingleActionForm
        action={continueWebsiteAction}
        fieldName="acknowledgement"
        fieldValue="continue"
        label="Continue to review"
      />
    </OnboardingShell>
  );
}
