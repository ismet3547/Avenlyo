import Link from 'next/link';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { canManageTeam } from '@/lib/team/capabilities';

/**
 * Settings index. Phase 15 replaces the Phase 0 placeholder only for the areas it owns; the rest of
 * the dashboard is untouched.
 */
export default async function SettingsPage() {
  const workspace = await requireCompletedWorkspace();

  return (
    <section className="max-w-3xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Dashboard
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        Settings
      </h1>

      <div className="mt-8 space-y-3">
        <Link
          className="block rounded-xl border border-border bg-white p-5 transition-colors hover:border-primary"
          href="/dashboard/settings/team"
        >
          <p className="font-semibold text-ink">Team &amp; access</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManageTeam(workspace.role)
              ? 'Invite people, choose what they can reach, and remove access.'
              : 'See the workspace and location you have access to.'}
          </p>
        </Link>

        <Link
          className="block rounded-xl border border-border bg-white p-5 transition-colors hover:border-primary"
          href="/dashboard/billing"
        >
          <p className="font-semibold text-ink">Billing</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Subscription and usage for this workspace.
          </p>
        </Link>
      </div>
    </section>
  );
}
