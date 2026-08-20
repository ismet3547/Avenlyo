'use server';

import { WORKSPACE_PROOF_HEADER } from '@avenlyo/shared/workspace-proof';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { billingWorkspaceProof } from '@/lib/billing/workspace-proof';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

/**
 * Every billing action operates on the workspace the caller is currently selected into.
 *
 * The organization is resolved server-side by the trusted workspace resolver, which revalidates
 * the stored selection against what the database says this user may reach on this request. It is
 * never read from a form field, a query parameter, or a cookie-declared role.
 *
 * Sending that organization to the API was not enough on its own. The API cannot tell a selection
 * apart from an assertion: a user who administers both A and B is an authorized admin of B even
 * while selected into A, so membership alone would have let the same browser call the API directly
 * with the other organization. The selection is therefore signed here, where it was resolved, with
 * a server-only secret the browser never sees, and the API refuses any billing mutation whose
 * organization does not arrive under a matching proof for this same user.
 *
 * The user's own access token still travels with the request, so the database continues to prove
 * owner or admin authority for itself. The proof narrows what may be acted on; it never widens who
 * may act.
 */
async function callBillingApi(
  path: '/v1/billing/checkout' | '/v1/billing/portal' | '/v1/billing/refresh',
) {
  const workspace = await requireCompletedWorkspace();
  if (workspace.role === 'member')
    throw new Error('Billing is managed by an organization owner or admin.');
  const auth = await getRequiredAuthContext();
  if (!auth) throw new Error('Authentication is required.');
  const { data } = await auth.supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error('Authentication is required.');
  const proof = billingWorkspaceProof({
    organizationId: workspace.organizationId,
    userId: auth.user.id,
  });
  // A deployment missing the server-only secret fails here rather than sending a request the API
  // would reject anyway, and the message names no setting and no value.
  if (!proof) throw new Error('Billing is unavailable.');
  return fetch(`${process.env.AVENLYO_API_URL ?? 'http://localhost:4000'}${path}`, {
    body: JSON.stringify({ organizationId: workspace.organizationId }),
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      'Content-Type': 'application/json',
      [WORKSPACE_PROOF_HEADER]: proof,
    },
    method: 'POST',
  });
}

export async function startBillingCheckoutAction(): Promise<never> {
  const response = await callBillingApi('/v1/billing/checkout');
  const body = (await response.json()) as { action?: unknown; url?: unknown };
  if (body.action === 'manage_existing_subscription')
    redirect('/dashboard/billing?existing=subscription');
  if (body.action === 'billing_reconciliation_required')
    redirect('/dashboard/billing?existing=reconciliation');
  if (!response.ok || body.action !== 'checkout' || typeof body.url !== 'string') {
    throw new Error('Billing is unavailable.');
  }
  redirect(body.url);
}

export async function openBillingPortalAction(): Promise<never> {
  const response = await callBillingApi('/v1/billing/portal');
  const body = (await response.json()) as { url?: unknown };
  if (!response.ok || typeof body.url !== 'string')
    throw new Error('Billing portal is unavailable.');
  redirect(body.url);
}

export async function refreshBillingAction(): Promise<void> {
  const response = await callBillingApi('/v1/billing/refresh');
  if (!response.ok) throw new Error('Billing could not be refreshed.');
  revalidatePath('/dashboard/billing');
}
