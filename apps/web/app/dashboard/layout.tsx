import type { ReactNode } from 'react';
import { BillingBanner } from '@/components/billing-banner';
import { DashboardNavigation } from '@/components/dashboard-navigation';
import { loadBillingExecutionSummary } from '@/lib/billing/service';
import { loadSwitchableWorkspaces, requireCompletedWorkspace } from '@/lib/onboarding/session';
import { hasMultipleWorkspaces } from '@/lib/workspace/selection';
import { getRequiredAuthContext } from '@/lib/supabase/auth';
import { messagingRpc } from '@/lib/messaging/service';

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  const context = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const workspaces = await loadSwitchableWorkspaces();
  // One tenant- and location-scoped read per dashboard render. The Inbox page owns the bounded
  // refresh loop; navigation deliberately does not poll for this badge. The billing summary is
  // read alongside it and is scoped to the selected organization, so switching workspace changes
  // which billing state the banner describes.
  const [attentionCount, billing] = auth
    ? await Promise.all([
        messagingRpc(auth.supabase)('get_my_handoff_queue_summary', {
          target_location_id: context.locationId,
        }).then((response) => response.data?.[0]?.needs_attention ?? 0),
        loadBillingExecutionSummary(auth.supabase, context.organizationId),
      ])
    : [0, null];

  return (
    <div className="min-h-screen bg-muted/40 md:grid md:grid-cols-[15rem_1fr]">
      <DashboardNavigation
        attentionCount={attentionCount}
        canSwitchWorkspace={hasMultipleWorkspaces(workspaces)}
        locationName={context.locationName}
        organizationName={context.organizationName}
      />
      <main className="min-w-0 px-6 py-8 md:px-10">
        <BillingBanner summary={billing} />
        {children}
      </main>
    </div>
  );
}
