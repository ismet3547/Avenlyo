import 'server-only';

import { signWorkspaceProof } from '@avenlyo/shared/workspace-proof';

/**
 * Mints the trusted proof that a billing mutation is acting on the selected workspace.
 *
 * The secret is read from `process.env` here, in a module marked `server-only`, so importing it
 * from a client component is a build error rather than a leak. It is deliberately not part of
 * `lib/supabase/config.ts`: everything in that module is `NEXT_PUBLIC_` and reaches the browser,
 * and this value must never appear in a bundle, a page payload, a URL, or a log line.
 *
 * A missing or short secret produces no proof at all rather than an unsigned request, so a
 * half-configured deployment fails closed at the API instead of quietly falling back to the
 * body-trusting behaviour this replaced.
 */
export function billingWorkspaceProof(input: {
  readonly organizationId: string;
  readonly userId: string;
}): string | null {
  return signWorkspaceProof(process.env.AVENLYO_INTERNAL_BILLING_SECRET, {
    issuedAtSeconds: Math.floor(Date.now() / 1000),
    organizationId: input.organizationId,
    userId: input.userId,
  });
}
