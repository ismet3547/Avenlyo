'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import type { FormActionState } from '@/lib/forms/state';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';
import {
  createInvitation,
  revokeInvitation,
  revokeMember,
  updateMemberAccess,
} from '@/lib/team/service';

/**
 * Team mutations.
 *
 * Every action re-resolves the caller's workspace and hands the request to a narrow RPC that
 * revalidates their role in the database. Nothing here decides authority: the capability helpers
 * only choose what to render, and a form that reaches an action it should not have is refused by
 * PostgreSQL, not by this file.
 */

const invitationSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  role: z.enum(['admin', 'member']),
  locationIds: z.array(z.string().uuid()),
});

const accessSchema = z.object({
  membershipId: z.string().uuid(),
  role: z.enum(['admin', 'member']),
  locationIds: z.array(z.string().uuid()),
});

async function authorizedClient() {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  if (!auth) throw new Error('Authentication is required.');
  return { supabase: auth.supabase, workspace };
}

function failure(message: string): FormActionState {
  return { message, status: 'error' };
}

export async function createInvitationAction(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const parsed = invitationSchema.safeParse({
    email: formData.get('email'),
    locationIds: formData.getAll('locationIds').map(String),
    role: formData.get('role'),
  });

  if (!parsed.success) {
    return {
      fieldErrors: parsed.error.flatten().fieldErrors,
      message: 'Check the highlighted fields and try again.',
      status: 'error',
    };
  }

  // A member with no location can see nothing, so the requirement is stated here as well as in the
  // database. The database remains the one that enforces it.
  if (parsed.data.role === 'member' && parsed.data.locationIds.length === 0) {
    return failure('Select at least one location for a member invitation.');
  }

  const { supabase, workspace } = await authorizedClient();

  try {
    const created = await createInvitation(supabase, {
      email: parsed.data.email,
      locationIds: parsed.data.locationIds,
      organizationId: workspace.organizationId,
      role: parsed.data.role,
    });

    if (created.outcome === 'already_member') {
      return failure('That person is already an active member of this workspace.');
    }

    revalidatePath('/dashboard/settings/team');

    // The only moment the link exists. It is returned to the page for copying and is never stored,
    // logged, or recoverable from any later read.
    return {
      message: created.token ?? '',
      status: 'success',
    };
  } catch {
    return failure('The invitation could not be created.');
  }
}

export async function revokeInvitationAction(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const invitationId = z.string().uuid().safeParse(formData.get('invitationId'));
  if (!invitationId.success) return failure('That invitation could not be found.');

  const { supabase } = await authorizedClient();
  try {
    const outcome = await revokeInvitation(supabase, invitationId.data);
    revalidatePath('/dashboard/settings/team');
    // Replay is a success: the operator's intent is satisfied either way.
    return outcome === 'already_accepted'
      ? failure('That invitation was already accepted. Remove the member instead.')
      : { message: 'Invitation revoked.', status: 'success' };
  } catch {
    return failure('The invitation could not be revoked.');
  }
}

export async function updateMemberAccessAction(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const parsed = accessSchema.safeParse({
    locationIds: formData.getAll('locationIds').map(String),
    membershipId: formData.get('membershipId'),
    role: formData.get('role'),
  });
  if (!parsed.success) return failure('Check the highlighted fields and try again.');

  // Demotion has to name the new scope in the same submission, so there is never a moment where a
  // member holds the scope they had as an admin.
  if (parsed.data.role === 'member' && parsed.data.locationIds.length === 0) {
    return failure('Select at least one location for a member.');
  }

  const { supabase } = await authorizedClient();
  try {
    await updateMemberAccess(supabase, {
      locationIds: parsed.data.locationIds,
      membershipId: parsed.data.membershipId,
      role: parsed.data.role,
    });
    revalidatePath('/dashboard/settings/team');
    return { message: 'Access updated.', status: 'success' };
  } catch {
    return failure('That access change is not permitted.');
  }
}

export async function revokeMemberAction(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const membershipId = z.string().uuid().safeParse(formData.get('membershipId'));
  if (!membershipId.success) return failure('That member could not be found.');

  const { supabase } = await authorizedClient();
  try {
    const outcome = await revokeMember(supabase, membershipId.data);
    revalidatePath('/dashboard/settings/team');
    return outcome === 'already_revoked'
      ? { message: 'That member no longer has access.', status: 'success' }
      : { message: 'Access removed.', status: 'success' };
  } catch {
    return failure('That member could not be removed.');
  }
}
