import Link from 'next/link';

import { billingBanner, type BillingExecutionSummary } from '@/lib/billing/execution';

/**
 * The dashboard-level notice that customer automation is paused, or that a payment needs
 * attention. It is informational: it never blocks navigation, never hides customer history, and
 * only renders inside the dashboard, so no public page, invite route, or web-chat visitor ever
 * sees it.
 */
export function BillingBanner({ summary }: Readonly<{ summary: BillingExecutionSummary | null }>) {
  const banner = billingBanner(summary);
  if (!banner) return null;
  const tone =
    banner.tone === 'attention'
      ? 'border-amber-200 bg-amber-50 text-amber-950'
      : 'border-slate-300 bg-slate-50 text-slate-900';
  return (
    <p
      className={`mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-4 py-3 text-sm ${tone}`}
      data-testid="billing-banner"
      role="status"
    >
      <span>{banner.message}</span>
      {banner.href ? (
        <Link className="font-semibold underline" href={banner.href}>
          Review billing
        </Link>
      ) : null}
    </p>
  );
}
