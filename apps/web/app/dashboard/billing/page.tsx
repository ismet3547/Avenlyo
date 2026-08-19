import Link from 'next/link';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { billingRpc } from '@/lib/billing/service';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

import {
  openBillingPortalAction,
  refreshBillingAction,
  startBillingCheckoutAction,
} from './actions';

function formatDate(value: string | null): string {
  if (!value) return 'Not available';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(value),
  );
}

function statusLabel(status: string | null): string {
  if (!status) return 'Billing not configured';
  return status.replaceAll('_', ' ');
}

function usageRow(label: string, value: number) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-3 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <strong className="font-semibold text-ink">{value.toLocaleString()}</strong>
    </div>
  );
}

export default async function BillingPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ checkout?: string; existing?: string }> }>) {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const params = await searchParams;
  if (workspace.role === 'member') {
    return (
      <section className="max-w-3xl">
        <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          Settings
        </p>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
          Billing
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Billing is managed by an organization owner or admin.
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
  const [overviewResponse, usageResponse] = auth
    ? await Promise.all([
        billingRpc(auth.supabase)('get_my_billing_overview', {
          target_organization_id: workspace.organizationId,
        }),
        billingRpc(auth.supabase)('get_my_billing_usage_summary', {
          target_organization_id: workspace.organizationId,
        }),
      ])
    : [null, null];
  const overview = overviewResponse?.data?.[0] ?? null;
  const usage = usageResponse?.data?.[0] ?? null;
  const canSubscribe = overview?.can_subscribe ?? true;
  const canManageBilling = overview?.can_manage_billing ?? false;
  const hasAuthoritativePeriod = overview?.has_authoritative_period ?? false;

  return (
    <section className="max-w-3xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Settings
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        Billing
      </h1>
      {params.checkout === 'success' ? (
        <p className="mt-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950">
          Billing is being confirmed. Your subscription will appear here after Stripe sends its
          signed update.
        </p>
      ) : null}
      {params.checkout === 'cancelled' ? (
        <p className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Checkout was cancelled. No subscription changes were made.
        </p>
      ) : null}
      {params.existing === 'subscription' ? (
        <p className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          An existing subscription is managed in the Stripe billing portal.
        </p>
      ) : null}
      {params.existing === 'reconciliation' ? (
        <p className="mt-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950">
          Billing is being refreshed from Stripe. Please try again after the current update finishes.
        </p>
      ) : null}
      {overview?.billing_state === 'attention' ? (
        <p className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Your payment needs attention. Use Manage billing to update payment details in Stripe.
        </p>
      ) : null}
      {overview?.billing_state === 'review_required' ? (
        <p className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Billing needs attention. Refresh status or manage billing in Stripe to resolve the
          current subscription state.
        </p>
      ) : null}

      <div className="mt-8 rounded-2xl border border-border bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <h2 className="text-lg font-semibold text-ink">
              {overview?.plan_key
                ? 'Avenlyo Core'
                : overview?.has_current_subscription
                  ? 'Subscription needs review'
                  : 'No subscription'}
            </h2>
            <p className="mt-1 text-sm capitalize text-muted-foreground">
              {statusLabel(overview?.billing_state ?? null)}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {canSubscribe ? (
              <form action={startBillingCheckoutAction}>
                <button
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
                  type="submit"
                >
                  Subscribe
                </button>
              </form>
            ) : null}
            {canManageBilling ? (
              <form action={openBillingPortalAction}>
                <button
                  className="rounded-md border border-border px-4 py-2 text-sm font-semibold text-ink"
                  type="submit"
                >
                  Manage billing
                </button>
              </form>
            ) : null}
            <form action={refreshBillingAction}>
              <button
                className="rounded-md px-3 py-2 text-sm font-semibold text-muted-foreground hover:text-ink"
                type="submit"
              >
                Refresh status
              </button>
            </form>
          </div>
        </div>
        <dl className="mt-6 grid gap-4 border-t border-border pt-5 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Current period</dt>
            <dd className="mt-1 font-medium text-ink">
              {hasAuthoritativePeriod
                ? `${formatDate(overview?.current_period_start ?? null)} – ${formatDate(overview?.current_period_end ?? null)}`
                : 'Not available for the current subscription topology'}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Cancellation</dt>
            <dd className="mt-1 font-medium text-ink">
              {overview?.cancel_at_period_end
                ? `Ends ${formatDate(overview.current_period_end)}`
                : 'Not scheduled'}
            </dd>
          </div>
        </dl>
      </div>

      <div className="mt-6 rounded-2xl border border-border bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-ink">Usage</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {usage?.period_kind === 'stripe_billing_period'
            ? 'Current Stripe billing period.'
            : 'Current-month preview; no authoritative Stripe billing period is available.'}
        </p>
        <div className="mt-4">
          {usageRow('Voice seconds', usage?.voice_seconds ?? 0)}
          {usageRow('Outbound SMS', usage?.outbound_sms ?? 0)}
          {usageRow('AI text turns', usage?.ai_text_turns ?? 0)}
          {usageRow('Appointments booked', usage?.appointments_booked ?? 0)}
        </div>
      </div>
    </section>
  );
}
