import Link from 'next/link';

import { authLinkWithNext } from '@/lib/auth/next-destination';
import { getOptionalCurrentUser } from '@/lib/supabase/auth';

import { AcceptInvitation } from './accept-invitation';

/**
 * Invitation landing page.
 *
 * The token in the URL is a bearer credential, so this route is deliberately quiet. Before
 * authentication it reveals nothing — not the invited address, not the role, not the organization
 * name — because whoever opened the link is not yet known to be the person invited.
 *
 * Referrer-Policy is set to no-referrer so the token cannot leak through an outbound link, and no
 * analytics or tracking runs here.
 */
export const metadata = {
  referrer: 'no-referrer' as const,
  robots: { follow: false, index: false },
  title: 'Join a workspace',
};

interface InvitePageProps {
  readonly params: Promise<{ token: string }>;
}

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const user = await getOptionalCurrentUser();

  if (!user) {
    // The destination is carried through authentication so the person returns here rather than to
    // onboarding, which would bootstrap a personal workspace they never asked for.
    const next = `/invite/${token}`;
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <h1 className="font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
          Join a workspace
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Sign in or create an account to accept this invitation. Use the email address the
          invitation was sent to.
        </p>
        <div className="mt-6 flex gap-3">
          <Link
            className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            href={authLinkWithNext('/auth/sign-in', next)}
          >
            Sign in
          </Link>
          <Link
            className="inline-flex h-10 items-center rounded-md border border-input px-4 text-sm font-medium"
            href={authLinkWithNext('/auth/sign-up', next)}
          >
            Create account
          </Link>
        </div>
      </main>
    );
  }

  return <AcceptInvitation token={token} />;
}
