import { notFound } from 'next/navigation';

import { BusinessForm } from '@/components/onboarding/business-form';
import { LocationForm } from '@/components/onboarding/location-form';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';

import { saveBusinessSettingsAction, saveLocationSettingsAction } from './actions';

export default async function BusinessLocationSettingsPage() {
  const workspace = await requireCompletedWorkspace();
  if (workspace.role !== 'owner' && workspace.role !== 'admin') notFound();

  return (
    <section className="max-w-4xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Settings / Business &amp; location
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        Keep front-office facts current
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        These details are authoritative for Avenlyo. Update them when your clinic name, contact
        details, address, timezone, or opening hours change.
      </p>

      <section className="mt-8 rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
        <h2 className="text-xl font-semibold tracking-tight text-ink">Business</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Customer-facing name, website, and phone number.
        </p>
        <BusinessForm
          initialName={workspace.organizationName}
          initialPhone={workspace.businessPhone}
          initialWebsiteUrl={workspace.websiteUrl}
          saveAction={saveBusinessSettingsAction}
          submitLabel="Save business"
        />
      </section>

      <section className="mt-6 rounded-2xl border border-border bg-white p-6 shadow-sm sm:p-8">
        <h2 className="text-xl font-semibold tracking-tight text-ink">Primary location</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Address, timezone, and weekly opening hours used by the front office.
        </p>
        <LocationForm
          initialAddress={workspace.locationAddress}
          initialBusinessHours={workspace.businessHours}
          initialName={workspace.locationName}
          initialTimezone={workspace.locationTimezone}
          saveAction={saveLocationSettingsAction}
          submitLabel="Save location"
        />
      </section>
    </section>
  );
}
