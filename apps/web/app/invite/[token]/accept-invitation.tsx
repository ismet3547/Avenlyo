import Link from 'next/link';

import { invitationMessage } from '@/lib/team/invitation-messages';
import { acceptInvitation } from '@/lib/team/service';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

/**
 * Runs acceptance for an authenticated visitor.
 *
 * The only thing sent to the database is the token. Identity comes from the session and scope comes
 * from the durable invitation row, so nothing rendered here can influence what access is granted.
 */
export async function AcceptInvitation({ token }: { readonly token: string }) {
  const auth = await getRequiredAuthContext();
  if (!auth) {
    return null;
  }

  let outcome: ReturnType<typeof invitationMessage>;
  let accepted = false;
  try {
    const result = await acceptInvitation(auth.supabase, token);
    outcome = invitationMessage(result.outcome);
    accepted = result.outcome === 'accepted' || result.outcome === 'already_accepted';
  } catch {
    // A raw PostgreSQL or Supabase message would leak schema detail to a bearer-token holder.
    outcome = invitationMessage('invalid');
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        {outcome.title}
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{outcome.body}</p>
      {accepted ? (
        <Link
          className="mt-6 inline-flex h-10 w-fit items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          href="/auth/continue"
        >
          Continue to workspace
        </Link>
      ) : (
        <Link className="mt-6 text-sm font-semibold text-primary hover:underline" href="/dashboard">
          Go to your dashboard
        </Link>
      )}
    </main>
  );
}
