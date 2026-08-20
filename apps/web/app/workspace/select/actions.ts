'use server';

import { redirect } from 'next/navigation';

import { getRequiredAuthContext } from '@/lib/supabase/auth';
import { findSelectedOption, parseWorkspaceSelection } from '@/lib/workspace/selection';
import { loadWorkspaceOptions, writeWorkspaceSelection } from '@/lib/workspace/service';

/**
 * Records a workspace choice.
 *
 * The submitted key is revalidated against the caller's authorized set on the server before
 * anything is written. A member who edits the form to name a third location gets nothing: the key
 * simply will not match a context they hold.
 */
export async function selectWorkspaceAction(formData: FormData): Promise<never> {
  const auth = await getRequiredAuthContext();
  if (!auth) {
    redirect('/auth/sign-in');
  }

  const requested = formData.get('workspaceKey');
  const selection = parseWorkspaceSelection(typeof requested === 'string' ? requested : null);
  const options = await loadWorkspaceOptions(auth.supabase);
  const authorized = findSelectedOption(options, selection);

  if (!authorized || !selection) {
    // No detail about why: an unauthorized key and a malformed one look the same.
    redirect('/workspace/select?error=unavailable');
  }

  await writeWorkspaceSelection(selection);
  // The continuation resolver decides where this context belongs: a finished workspace goes to the
  // dashboard, one still in setup goes to its persisted onboarding step. Redirecting straight to
  // /dashboard would push an unfinished workspace into a surface that assumes it is finished.
  redirect('/auth/continue');
}
