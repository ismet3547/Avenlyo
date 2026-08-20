/**
 * How billing execution state is described to people, as one pure module.
 *
 * Two distinctions carry the whole surface and both are easy to lose in a template:
 *
 *   * Configuration intent is not execution availability. A Voice number the owner enabled is
 *     still enabled while billing is paused; it is not "Disabled". Phase 17 never rewrites a
 *     configuration flag to represent a billing state, so the UI has to hold both facts at once.
 *   * An owner or admin can act on billing; a member cannot. A member who cannot send a reply
 *     deserves to know why, but not to be shown a Stripe detail or a billing management path they
 *     have no authority over.
 *
 * Nothing here receives a Stripe customer, subscription, product, or price identifier, because the
 * summary RPC does not return one.
 */

export type BillingState = 'active' | 'attention' | 'inactive' | 'review_required' | 'unconfigured';

export type BillingFeature =
  'voice' | 'sms' | 'web_chat' | 'appointments' | 'lead_capture' | 'reminders' | 'lead_followups';

/** Exactly the shape `get_my_billing_execution_summary` returns. */
export interface BillingExecutionSummary {
  readonly automation_available: boolean;
  readonly billing_state: BillingState;
  readonly can_manage_billing: boolean;
  readonly voice: boolean;
  readonly sms: boolean;
  readonly web_chat: boolean;
  readonly appointments: boolean;
  readonly lead_capture: boolean;
  readonly reminders: boolean;
  readonly lead_followups: boolean;
}

/**
 * Owner and admin headline for the Billing page. `attention` deliberately says automation is still
 * running: a recoverable payment problem is a warning, not a suspension, and telling an owner their
 * business is off when it is not would be worse than saying nothing. No wording claims that an
 * inactive subscription deletes anything, because it does not.
 */
export const BILLING_EXECUTION_HEADLINES: Readonly<Record<BillingState, string>> = {
  active: 'Automation active',
  attention: 'Automation remains active; payment needs attention',
  inactive: 'New customer automation is paused',
  review_required: 'Automation is paused while billing needs review',
  unconfigured: 'Subscribe to activate customer automation.',
};

/**
 * What a member is told when a production action is unavailable. It names no provider, no billing
 * state, and no amount: it says who can fix it.
 */
export const MEMBER_AUTOMATION_UNAVAILABLE =
  'Automation is currently unavailable. Ask an owner or admin to review billing.';

export interface BillingBanner {
  readonly href: string | null;
  readonly message: string;
  readonly tone: 'attention' | 'paused';
}

/**
 * The compact dashboard warning. It appears only when automation is actually paused or payment
 * needs attention, never blocks navigation, and only offers a path to Billing to someone who can
 * act on it.
 */
export function billingBanner(summary: BillingExecutionSummary | null): BillingBanner | null {
  if (!summary) return null;
  if (summary.billing_state === 'attention') {
    // The same sentence for everyone: it is true, it is not sensitive, and it says the business is
    // still running. Only the path to act on it depends on authority.
    return {
      href: summary.can_manage_billing ? '/dashboard/billing' : null,
      message: 'A payment needs attention. Customer automation is still running.',
      tone: 'attention',
    };
  }
  if (summary.automation_available) return null;
  return {
    href: summary.can_manage_billing ? '/dashboard/billing' : null,
    message: summary.can_manage_billing
      ? 'New customer automation is paused. Review billing to resume it.'
      : MEMBER_AUTOMATION_UNAVAILABLE,
    tone: 'paused',
  };
}

/**
 * The label for a channel the owner has configured. "Enabled · paused by billing" keeps both facts
 * visible; collapsing it to "Disabled" would misreport the owner's own configuration back to them
 * and imply they need to turn something back on after paying, which they do not.
 */
export function channelAvailabilityLabel(input: {
  readonly configured: boolean;
  readonly entitled: boolean;
}): string {
  if (!input.configured) return 'Disabled';
  return input.entitled ? 'Enabled' : 'Enabled · paused by billing';
}

/** Whether a surface should explain that execution is paused despite an enabled configuration. */
export function isPausedByBilling(input: {
  readonly configured: boolean;
  readonly entitled: boolean;
}): boolean {
  return input.configured && !input.entitled;
}
