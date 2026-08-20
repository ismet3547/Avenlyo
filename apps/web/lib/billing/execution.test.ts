import { describe, expect, it } from 'vitest';

import {
  BILLING_EXECUTION_HEADLINES,
  MEMBER_AUTOMATION_UNAVAILABLE,
  billingBanner,
  channelAvailabilityLabel,
  isPausedByBilling,
  type BillingExecutionSummary,
  type BillingState,
} from './execution';

function summary(overrides: Partial<BillingExecutionSummary> = {}): BillingExecutionSummary {
  return {
    appointments: true,
    automation_available: true,
    billing_state: 'active',
    can_manage_billing: true,
    lead_capture: true,
    lead_followups: true,
    reminders: true,
    sms: true,
    voice: true,
    web_chat: true,
    ...overrides,
  };
}

const PAUSED_STATES: readonly BillingState[] = ['inactive', 'review_required', 'unconfigured'];

describe('billing execution headlines', () => {
  it('tells an owner automation is still running while payment needs attention', () => {
    // The single most damaging wrong sentence on this page would be one that reads like an
    // outage during a recoverable payment problem, because attention is deliberately entitled.
    expect(BILLING_EXECUTION_HEADLINES.attention).toContain('remains active');
    expect(BILLING_EXECUTION_HEADLINES.attention).toContain('attention');
  });

  it('describes each paused state as paused rather than as data loss', () => {
    expect(BILLING_EXECUTION_HEADLINES.inactive).toBe('New customer automation is paused');
    expect(BILLING_EXECUTION_HEADLINES.review_required).toBe(
      'Automation is paused while billing needs review',
    );
    expect(BILLING_EXECUTION_HEADLINES.unconfigured).toBe(
      'Subscribe to activate customer automation.',
    );
    for (const headline of Object.values(BILLING_EXECUTION_HEADLINES)) {
      expect(headline.toLowerCase()).not.toMatch(/delete|erase|remove|lost/);
    }
  });

  it('says automation is active when it is', () => {
    expect(BILLING_EXECUTION_HEADLINES.active).toBe('Automation active');
  });
});

describe('dashboard billing banner', () => {
  it('stays hidden while automation is available', () => {
    expect(billingBanner(summary())).toBeNull();
  });

  it('stays hidden when nothing could be read', () => {
    expect(billingBanner(null)).toBeNull();
  });

  it('warns without claiming a suspension while payment needs attention', () => {
    const banner = billingBanner(summary({ billing_state: 'attention' }));
    expect(banner?.tone).toBe('attention');
    expect(banner?.message).toContain('still running');
  });

  it('reports a pause for every unavailable state', () => {
    for (const state of PAUSED_STATES) {
      const banner = billingBanner(summary({ automation_available: false, billing_state: state }));
      expect(banner?.tone).toBe('paused');
    }
  });

  it('offers a billing path only to someone who may act on it', () => {
    const owner = billingBanner(
      summary({ automation_available: false, billing_state: 'inactive' }),
    );
    const member = billingBanner(
      summary({
        automation_available: false,
        billing_state: 'inactive',
        can_manage_billing: false,
      }),
    );
    expect(owner?.href).toBe('/dashboard/billing');
    expect(member?.href).toBeNull();
    expect(member?.message).toBe(MEMBER_AUTOMATION_UNAVAILABLE);
  });

  it('never exposes a provider identifier or a state category to a member', () => {
    const member = billingBanner(
      summary({
        automation_available: false,
        billing_state: 'review_required',
        can_manage_billing: false,
      }),
    );
    expect(member?.message).not.toMatch(
      /stripe|subscription|cus_|sub_|price|product|review_required/i,
    );
  });
});

describe('configuration intent versus execution availability', () => {
  it('keeps an owner-enabled channel reported as enabled while billing pauses it', () => {
    expect(channelAvailabilityLabel({ configured: true, entitled: false })).toBe(
      'Enabled · paused by billing',
    );
    expect(channelAvailabilityLabel({ configured: true, entitled: false })).not.toBe('Disabled');
  });

  it('reports an owner-disabled channel as disabled regardless of billing', () => {
    expect(channelAvailabilityLabel({ configured: false, entitled: true })).toBe('Disabled');
    expect(channelAvailabilityLabel({ configured: false, entitled: false })).toBe('Disabled');
  });

  it('reports an entitled, configured channel as plainly enabled', () => {
    expect(channelAvailabilityLabel({ configured: true, entitled: true })).toBe('Enabled');
  });

  it('flags the paused-but-configured case and nothing else', () => {
    expect(isPausedByBilling({ configured: true, entitled: false })).toBe(true);
    expect(isPausedByBilling({ configured: true, entitled: true })).toBe(false);
    expect(isPausedByBilling({ configured: false, entitled: false })).toBe(false);
  });
});
