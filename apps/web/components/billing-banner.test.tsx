import { readFileSync } from 'node:fs';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { BillingExecutionSummary } from '@/lib/billing/execution';

import { BillingBanner } from './billing-banner';

function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .split('\r\n')
    .join('\n');
}

function summary(overrides: Partial<BillingExecutionSummary> = {}): BillingExecutionSummary {
  return {
    appointments: false,
    automation_available: false,
    billing_state: 'inactive',
    can_manage_billing: true,
    lead_capture: false,
    lead_followups: false,
    reminders: false,
    sms: false,
    voice: false,
    web_chat: false,
    ...overrides,
  };
}

describe('dashboard billing banner', () => {
  it('renders nothing when automation is available', () => {
    const markup = renderToStaticMarkup(
      <BillingBanner summary={summary({ automation_available: true, billing_state: 'active' })} />,
    );
    expect(markup).toBe('');
  });

  it('links an owner to billing and a member nowhere', () => {
    const owner = renderToStaticMarkup(<BillingBanner summary={summary()} />);
    const member = renderToStaticMarkup(
      <BillingBanner summary={summary({ can_manage_billing: false })} />,
    );
    expect(owner).toContain('/dashboard/billing');
    expect(member).not.toContain('href');
    expect(member).toContain('Ask an owner or admin to review billing.');
  });

  it('never renders a Stripe identifier, because it is never given one', () => {
    const markup = renderToStaticMarkup(<BillingBanner summary={summary()} />);
    expect(markup).not.toMatch(/cus_|sub_|price_|prod_|stripe/i);
  });
});

describe('billing surfaces are wired to execution state, not to configuration flags', () => {
  const dashboardLayout = readSource('../app/dashboard/layout.tsx');
  const voicePage = readSource('../app/dashboard/ai-front-office/voice/page.tsx');
  const webChatPage = readSource('../app/dashboard/ai-front-office/web-chat/page.tsx');
  const billingPage = readSource('../app/dashboard/billing/page.tsx');
  const billingActions = readSource('../app/dashboard/billing/actions.ts');
  const chatWidget = readSource('../app/chat/widget/page.tsx');
  const inboxMessages = readSource('../app/dashboard/inbox/queue-view.ts');

  it('shows the banner inside the dashboard only', () => {
    expect(dashboardLayout).toContain('<BillingBanner summary={billing} />');
    // The dashboard layout is the only place it is mounted, so no public page, invite route, or
    // hosted widget can render it.
    expect(chatWidget).not.toContain('BillingBanner');
  });

  it('scopes the banner to the selected organization', () => {
    expect(dashboardLayout).toContain(
      'loadBillingExecutionSummary(auth.supabase, context.organizationId)',
    );
  });

  it('reports Voice and Web Chat as configured-but-paused instead of mutating the flag', () => {
    expect(voicePage).toContain(
      'channelAvailabilityLabel({ configured: voiceConfigured, entitled: voiceEntitled })',
    );
    expect(voicePage).not.toContain("configuration?.enabled ? 'Enabled' : 'Disabled'");
    expect(webChatPage).toContain('isPausedByBilling({');
    // Neither page may write an enabled flag from a billing fact.
    expect(voicePage).not.toMatch(/enabled:\s*(billing|.*entitled)/);
    expect(webChatPage).not.toMatch(/enabled:\s*(billing|.*entitled)/);
  });

  it('describes billing state on the Billing page as execution state', () => {
    expect(billingPage).toContain('executionLabel(overview?.billing_state ?? null)');
    // The old surface printed the raw provider status with underscores stripped.
    expect(billingPage).not.toContain("status.replaceAll('_', ' ')");
  });

  it('sends the server-resolved organization with every billing action', () => {
    expect(billingActions).toContain(
      'JSON.stringify({ organizationId: workspace.organizationId })',
    );
    expect(billingActions).toContain('requireCompletedWorkspace()');
    // No form field, query parameter, or cookie chooses the billing organization.
    expect(billingActions).not.toMatch(/formData|searchParams|cookies\(\)/);
  });

  it('gives a blocked operator a safe reason and a blocked visitor a generic one', () => {
    expect(inboxMessages).toContain(
      "billing_unavailable: 'Customer messaging is paused. Ask an owner or admin to review billing.',",
    );
    expect(chatWidget).toContain("setError('Chat is temporarily unavailable.')");
    // The visible strings, not the surrounding prose: an explanatory comment may name Stripe, a
    // sentence shown to an operator or a website visitor may not.
    const visible = [
      ...inboxMessages.matchAll(/^\s*\w+: '([^']+)',$/gm),
      ...chatWidget.matchAll(/setError\('([^']+)'\)/g),
    ].map((match) => match[1] ?? '');
    expect(visible.length).toBeGreaterThan(5);
    for (const sentence of visible) {
      expect(sentence).not.toMatch(/stripe|subscription|cus_|sub_|price_|prod_/i);
    }
  });
});
