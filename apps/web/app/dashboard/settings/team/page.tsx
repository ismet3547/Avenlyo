import Link from 'next/link';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';
import {
  canChangeRole,
  canManageMember,
  canManageTeam,
  invitableRoles,
} from '@/lib/team/capabilities';
import { loadTeamOverview } from '@/lib/team/service';
import { loadWorkspaceOptions } from '@/lib/workspace/service';

import { TeamManagement } from './team-management';

function formatDate(value: string | null): string {
  if (!value) return 'Not available';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(value),
  );
}

export default async function TeamSettingsPage() {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();

  // A normal member has no management authority at all, so they get their own access rather than a
  // page of controls that would be refused. Disabled buttons for operations somebody can never
  // perform are noise pretending to be a feature.
  if (!canManageTeam(workspace.role) || !auth) {
    return (
      <section className="max-w-3xl">
        <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          Settings
        </p>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
          Your access
        </h1>
        <dl className="mt-6 space-y-4 rounded-xl border border-border bg-white p-6 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Workspace</dt>
            <dd className="font-semibold text-ink">{workspace.organizationName}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Role</dt>
            <dd className="font-semibold text-ink">{workspace.role}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Location</dt>
            <dd className="font-semibold text-ink">{workspace.locationName ?? 'Not assigned'}</dd>
          </div>
        </dl>
        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          Team access is managed by an organization owner or admin.
        </p>
        <Link
          className="mt-6 inline-flex text-sm font-semibold text-primary hover:underline"
          href="/dashboard"
        >
          Back to dashboard
        </Link>
      </section>
    );
  }

  const [overview, workspaceOptions] = await Promise.all([
    loadTeamOverview(auth.supabase, workspace.organizationId),
    loadWorkspaceOptions(auth.supabase),
  ]);

  // Owner and admin are organization-wide, so every location in this organization is assignable.
  const locations = workspaceOptions
    .filter((option) => option.organizationId === workspace.organizationId && option.locationId)
    .map((option) => ({
      id: option.locationId as string,
      name: option.locationName ?? 'Location',
    }));

  const members = overview.members.map((member) => ({
    ...member,
    canManage: canManageMember(workspace.role, member.role) && member.isActive,
    canChangeRole: canChangeRole(workspace.role, member.role) && member.isActive,
  }));

  const pendingInvitations = overview.invitations.filter(
    (invitation) => invitation.state === 'pending',
  );
  const recentInvitations = overview.invitations.filter(
    (invitation) => invitation.state !== 'pending',
  );

  return (
    <section className="max-w-4xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Settings
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        Team &amp; access
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        Invite people to {workspace.organizationName}, choose what they can reach, and remove access
        when they leave. Access changes take effect on their next request.
      </p>

      <TeamManagement
        invitableRoles={invitableRoles(workspace.role)}
        locations={locations}
        members={members}
        pendingInvitations={pendingInvitations.map((invitation) => ({
          ...invitation,
          expiresLabel: formatDate(invitation.expiresAt),
        }))}
        recentInvitations={recentInvitations.map((invitation) => ({
          ...invitation,
          expiresLabel: formatDate(invitation.expiresAt),
        }))}
      />
    </section>
  );
}
