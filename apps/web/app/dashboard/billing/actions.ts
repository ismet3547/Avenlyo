'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

/**
 * Every billing action operates on the workspace the caller is currently selected into.
 *
 * The organization is resolved server-side by the trusted workspace resolver, which revalidates
 * the stored selection against what the database says this user may reach on this request. It is
 * never read from a form field, a query parameter, or a cookie-declared role, and the database
 * proves owner/admin authority on it again before any billing row is touched. An owner of A who
 * also administers B therefore acts on exactly the one they are looking at.
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
  return fetch(`${process.env.AVENLYO_API_URL ?? 'http://localhost:4000'}${path}`, {
    body: JSON.stringify({ organizationId: workspace.organizationId }),
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      'Content-Type': 'application/json',
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
