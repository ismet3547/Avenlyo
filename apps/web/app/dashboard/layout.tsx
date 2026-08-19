import type { ReactNode } from 'react';
import { DashboardNavigation } from '@/components/dashboard-navigation';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';
import { messagingRpc } from '@/lib/messaging/service';

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  const context = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  // One tenant- and location-scoped read per dashboard render. The Inbox page owns the bounded
  // refresh loop; navigation deliberately does not poll for this badge.
  const attentionCount = auth
    ? ((
        await messagingRpc(auth.supabase)('get_my_handoff_queue_summary', {
          target_location_id: context.locationId,
        })
      ).data?.[0]?.needs_attention ?? 0)
    : 0;

  return (
    <div className="min-h-screen bg-muted/40 md:grid md:grid-cols-[15rem_1fr]">
      <DashboardNavigation
        attentionCount={attentionCount}
        locationName={context.locationName}
        organizationName={context.organizationName}
      />
      <main className="min-w-0 px-6 py-8 md:px-10">{children}</main>
    </div>
  );
}
