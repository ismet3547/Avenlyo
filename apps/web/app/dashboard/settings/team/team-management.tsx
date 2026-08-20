'use client';

import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { initialFormActionState, type FormActionState } from '@/lib/forms/state';

import {
  createInvitationAction,
  revokeInvitationAction,
  revokeMemberAction,
  updateMemberAccessAction,
} from './actions';

/**
 * Team management surface.
 *
 * Every control shown here corresponds to something the viewer's role can actually do. The
 * capability decisions were made on the server; this component renders them. Authorization itself
 * lives in the database, so a tampered form reaches an RPC that refuses it.
 */

export interface TeamLocation {
  readonly id: string;
  readonly name: string;
}

export interface TeamMemberView {
  readonly activeWorkCount: number;
  readonly canChangeRole: boolean;
  readonly canManage: boolean;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly isActive: boolean;
  readonly locationIds: readonly string[];
  readonly locationNames: readonly string[];
  readonly membershipId: string;
  readonly role: 'owner' | 'admin' | 'member';
}

export interface TeamInvitationView {
  readonly email: string;
  readonly expiresLabel: string;
  readonly invitationId: string;
  readonly locationNames: readonly string[];
  readonly role: string;
  readonly state: string;
}

interface TeamManagementProps {
  readonly invitableRoles: readonly ('admin' | 'member')[];
  readonly locations: readonly TeamLocation[];
  readonly members: readonly TeamMemberView[];
  readonly pendingInvitations: readonly TeamInvitationView[];
  readonly recentInvitations: readonly TeamInvitationView[];
}

function LocationChips({ names }: { readonly names: readonly string[] }) {
  if (names.length === 0) {
    return <span className="text-xs text-muted-foreground">Organization-wide</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {names.map((name) => (
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-ink" key={name}>
          {name}
        </span>
      ))}
    </span>
  );
}

function InvitationLink({ state }: { readonly state: FormActionState }) {
  const token = state.status === 'success' ? state.message : '';
  if (!token) return null;

  // Shown once, immediately after creation. Nothing can retrieve it later: to replace a lost link
  // the operator reissues, which invalidates the previous token.
  const url = `${typeof window === 'undefined' ? '' : window.location.origin}/invite/${token}`;
  return (
    <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
      <p className="text-sm font-semibold text-blue-950">Invitation link created</p>
      <p className="mt-1 text-xs leading-5 text-blue-900">
        Copy this link and send it to the person you invited. It is shown only once and expires in
        seven days. Treat it like a password.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          className="w-full rounded-md border border-blue-200 bg-white px-3 py-2 font-mono text-xs text-ink"
          data-testid="invitation-link"
          readOnly
          value={url}
        />
        <Button
          onClick={() => void navigator.clipboard?.writeText(url)}
          type="button"
          variant="outline"
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

function InviteForm({
  invitableRoles,
  locations,
}: {
  readonly invitableRoles: readonly ('admin' | 'member')[];
  readonly locations: readonly TeamLocation[];
}) {
  const [state, action, pending] = useActionState(createInvitationAction, initialFormActionState);
  const [role, setRole] = useState<'admin' | 'member'>(invitableRoles[0] ?? 'member');

  return (
    <div className="mt-8 rounded-xl border border-border bg-white p-6">
      <h2 className="font-display text-lg font-semibold text-ink">Invite someone</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Avenlyo creates a secure link. Send it to them yourself; no email is sent from here.
      </p>
      <form action={action} className="mt-5 space-y-4">
        <label className="block text-sm font-medium text-ink">
          Email address
          <input
            className="mt-1 w-full rounded-md border border-input px-3 py-2 text-sm"
            name="email"
            required
            type="email"
          />
        </label>

        <fieldset>
          <legend className="text-sm font-medium text-ink">Role</legend>
          <div className="mt-2 flex gap-4">
            {invitableRoles.map((option) => (
              <label className="flex items-center gap-2 text-sm" key={option}>
                <input
                  checked={role === option}
                  name="role"
                  onChange={() => setRole(option)}
                  type="radio"
                  value={option}
                />
                {option === 'admin' ? 'Admin — full workspace access' : 'Member — chosen locations'}
              </label>
            ))}
          </div>
        </fieldset>

        {role === 'member' ? (
          <fieldset>
            <legend className="text-sm font-medium text-ink">Locations</legend>
            <p className="text-xs text-muted-foreground">
              A member can only see the locations you choose. Pick at least one.
            </p>
            <div className="mt-2 space-y-2">
              {locations.map((location) => (
                <label className="flex items-center gap-2 text-sm" key={location.id}>
                  <input name="locationIds" type="checkbox" value={location.id} />
                  {location.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {state.status === 'error' && state.message ? (
          <p className="text-sm text-red-700">{state.message}</p>
        ) : null}

        <Button disabled={pending} type="submit">
          {pending ? 'Creating…' : 'Create invitation link'}
        </Button>
      </form>
      <InvitationLink state={state} />
    </div>
  );
}

function MemberRow({
  locations,
  member,
}: {
  readonly locations: readonly TeamLocation[];
  readonly member: TeamMemberView;
}) {
  const [accessState, accessAction, accessPending] = useActionState(
    updateMemberAccessAction,
    initialFormActionState,
  );
  const [revokeState, revokeAction, revokePending] = useActionState(
    revokeMemberAction,
    initialFormActionState,
  );
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState<'admin' | 'member'>(
    member.role === 'admin' ? 'admin' : 'member',
  );

  return (
    <li className="border-b border-border py-4 last:border-b-0" data-testid="team-member">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">
            {member.displayName ?? member.email ?? 'Team member'}
            {member.isActive ? null : (
              <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                Access removed
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">{member.email}</p>
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-primary">
            {member.role}
          </p>
          <div className="mt-2">
            <LocationChips names={member.locationNames} />
          </div>
        </div>

        {member.canManage ? (
          <div className="flex gap-2">
            <Button onClick={() => setEditing((value) => !value)} type="button" variant="outline">
              {editing ? 'Cancel' : 'Edit access'}
            </Button>
            <form action={revokeAction}>
              <input name="membershipId" type="hidden" value={member.membershipId} />
              <Button disabled={revokePending} type="submit" variant="outline">
                {revokePending ? 'Removing…' : 'Remove access'}
              </Button>
            </form>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Read only</span>
        )}
      </div>

      {/* A safe count only. The Team page must never become a way to read customer conversations. */}
      {member.canManage && member.activeWorkCount > 0 ? (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
          This person is currently handling {member.activeWorkCount} conversation
          {member.activeWorkCount === 1 ? '' : 's'}. Removing access ends it immediately; the
          conversations stay assigned to them until an owner or admin uses Release in the Inbox and
          another teammate Claims them. Nothing is auto-resolved and the AI is not resumed.
        </p>
      ) : null}

      {editing && member.canManage ? (
        <form action={accessAction} className="mt-4 space-y-3 rounded-lg bg-muted/40 p-4">
          <input name="membershipId" type="hidden" value={member.membershipId} />
          {member.canChangeRole ? (
            <fieldset>
              <legend className="text-sm font-medium text-ink">Role</legend>
              <div className="mt-2 flex gap-4">
                {(['admin', 'member'] as const).map((option) => (
                  <label className="flex items-center gap-2 text-sm" key={option}>
                    <input
                      checked={role === option}
                      name="role"
                      onChange={() => setRole(option)}
                      type="radio"
                      value={option}
                    />
                    {option}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <input name="role" type="hidden" value="member" />
          )}

          {role === 'member' ? (
            <fieldset>
              <legend className="text-sm font-medium text-ink">Locations</legend>
              <div className="mt-2 space-y-2">
                {locations.map((location) => (
                  <label className="flex items-center gap-2 text-sm" key={location.id}>
                    <input
                      defaultChecked={member.locationIds.includes(location.id)}
                      name="locationIds"
                      type="checkbox"
                      value={location.id}
                    />
                    {location.name}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <p className="text-xs text-muted-foreground">
              An admin has access to every location in this workspace.
            </p>
          )}

          {accessState.status === 'error' && accessState.message ? (
            <p className="text-sm text-red-700">{accessState.message}</p>
          ) : null}
          <Button disabled={accessPending} type="submit">
            {accessPending ? 'Saving…' : 'Save access'}
          </Button>
        </form>
      ) : null}

      {revokeState.status === 'error' && revokeState.message ? (
        <p className="mt-2 text-sm text-red-700">{revokeState.message}</p>
      ) : null}
    </li>
  );
}

function InvitationRow({ invitation }: { readonly invitation: TeamInvitationView }) {
  const [state, action, pending] = useActionState(revokeInvitationAction, initialFormActionState);

  return (
    <li className="border-b border-border py-4 last:border-b-0" data-testid="team-invitation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{invitation.email}</p>
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-primary">
            {invitation.role} · {invitation.state}
          </p>
          <p className="text-xs text-muted-foreground">Expires {invitation.expiresLabel}</p>
          <div className="mt-2">
            <LocationChips names={invitation.locationNames} />
          </div>
        </div>
        {invitation.state === 'pending' ? (
          <form action={action}>
            <input name="invitationId" type="hidden" value={invitation.invitationId} />
            <Button disabled={pending} type="submit" variant="outline">
              {pending ? 'Revoking…' : 'Revoke'}
            </Button>
          </form>
        ) : null}
      </div>
      {state.status === 'error' && state.message ? (
        <p className="mt-2 text-sm text-red-700">{state.message}</p>
      ) : null}
    </li>
  );
}

export function TeamManagement({
  invitableRoles,
  locations,
  members,
  pendingInvitations,
  recentInvitations,
}: TeamManagementProps) {
  return (
    <div>
      <InviteForm invitableRoles={invitableRoles} locations={locations} />

      <div className="mt-8 rounded-xl border border-border bg-white p-6">
        <h2 className="font-display text-lg font-semibold text-ink">Team members</h2>
        <ul className="mt-2">
          {members.map((member) => (
            <MemberRow key={member.membershipId} locations={locations} member={member} />
          ))}
        </ul>
      </div>

      <div className="mt-8 rounded-xl border border-border bg-white p-6">
        <h2 className="font-display text-lg font-semibold text-ink">Pending invitations</h2>
        {pendingInvitations.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No invitations are waiting.</p>
        ) : (
          <ul className="mt-2">
            {pendingInvitations.map((invitation) => (
              <InvitationRow invitation={invitation} key={invitation.invitationId} />
            ))}
          </ul>
        )}
        {/* The link is never recoverable from this list: only its hash is stored. */}
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          Invitation links cannot be shown again. To replace a lost link, invite the same address
          again — the previous link stops working immediately.
        </p>
      </div>

      {recentInvitations.length > 0 ? (
        <div className="mt-8 rounded-xl border border-border bg-white p-6">
          <h2 className="font-display text-lg font-semibold text-ink">Recent invitations</h2>
          <ul className="mt-2">
            {recentInvitations.map((invitation) => (
              <InvitationRow invitation={invitation} key={invitation.invitationId} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
