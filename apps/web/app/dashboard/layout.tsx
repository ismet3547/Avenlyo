import type { ReactNode } from 'react';
import { DashboardNavigation } from '@/components/dashboard-navigation';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  const context = await requireCompletedWorkspace();

  return (
    <div className="min-h-screen bg-muted/40 md:grid md:grid-cols-[15rem_1fr]">
      <DashboardNavigation
        locationName={context.locationName}
        organizationName={context.organizationName}
      />
      <main className="min-w-0 px-6 py-8 md:px-10">{children}</main>
    </div>
  );
}
