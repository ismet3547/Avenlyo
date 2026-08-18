import Link from 'next/link';

import { saveLeadFollowupSettingsAction } from './actions';
import { followupsRpc } from '@/lib/followups/service';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

function time(value: string): string {
  return value.slice(0, 5);
}

export default async function LeadFollowupsPage() {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const settings =
    auth && workspace.locationId
      ? (
          await followupsRpc(auth.supabase)('get_my_lead_followup_settings', {
            target_location_id: workspace.locationId,
          })
        ).data?.[0]
      : null;
  if (!workspace.locationId || workspace.role === 'member') {
    return (
      <section className="max-w-3xl">
        <h1 className="font-display text-3xl font-semibold text-ink">Lead follow-ups</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Follow-up settings are managed by an organization owner or admin.
        </p>
        <Link
          className="mt-6 inline-flex text-sm font-semibold text-primary hover:underline"
          href="/dashboard/leads"
        >
          Back to leads
        </Link>
      </section>
    );
  }
  const configured = settings ?? {
    automation_acknowledged_at: null,
    business_hours_only: true,
    delay_minutes: 240,
    lead_followup_enabled: false,
    quiet_hours_end: '08:00',
    quiet_hours_start: '20:00',
    sender_available: false,
  };
  return (
    <section className="max-w-3xl">
      <Link className="text-sm font-semibold text-primary hover:underline" href="/dashboard/leads">
        ← Back to leads
      </Link>
      <p className="mt-7 font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Leads
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
        Consent-aware follow-ups
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        Avenlyo can schedule one neutral follow-up only after the customer explicitly opts in on the
        exact SMS route. It is not a campaign or nurture sequence.
      </p>
      <form
        action={saveLeadFollowupSettingsAction}
        className="mt-8 space-y-6 rounded-2xl border border-border bg-white p-6 shadow-sm"
      >
        {!configured.sender_available ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            An active SMS-enabled business number is required before this can be enabled.
          </p>
        ) : null}
        <label className="flex items-start gap-3 text-sm">
          <input
            className="mt-1 size-4 accent-primary"
            defaultChecked={configured.lead_followup_enabled}
            disabled={!configured.sender_available}
            name="enabled"
            type="checkbox"
          />
          <span>
            <strong className="font-semibold text-ink">Enable one lead follow-up</strong>
            <br />
            <span className="text-muted-foreground">
              Only unconverted, unattended, non-urgent leads with explicit consent are eligible.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3 border-t border-border pt-5 text-sm">
          <input
            className="mt-1 size-4 accent-primary"
            defaultChecked={configured.automation_acknowledged_at !== null}
            name="acknowledgeSender"
            type="checkbox"
          />
          <span>
            <strong className="font-semibold text-ink">Confirm sender authorization</strong>
            <br />
            <span className="text-muted-foreground">
              Your business is responsible for ensuring this sender, use case, and consent flow are
              authorized for these messages.
            </span>
          </span>
        </label>
        <label className="grid max-w-48 gap-2 border-t border-border pt-5 text-sm font-medium text-ink">
          Delay (minutes)
          <input
            className="rounded-md border border-input px-3 py-2"
            defaultValue={configured.delay_minutes}
            max="10080"
            min="15"
            name="delayMinutes"
            type="number"
            required
          />
        </label>
        <fieldset className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
          <legend className="col-span-full text-sm font-semibold text-ink">Quiet hours</legend>
          <label className="grid gap-2 text-sm font-medium text-ink">
            Start
            <input
              className="rounded-md border border-input px-3 py-2"
              defaultValue={time(configured.quiet_hours_start)}
              name="quietHoursStart"
              type="time"
              required
            />
          </label>
          <label className="grid gap-2 text-sm font-medium text-ink">
            End
            <input
              className="rounded-md border border-input px-3 py-2"
              defaultValue={time(configured.quiet_hours_end)}
              name="quietHoursEnd"
              type="time"
              required
            />
          </label>
        </fieldset>
        <label className="flex items-start gap-3 border-t border-border pt-5 text-sm">
          <input
            className="mt-1 size-4 accent-primary"
            defaultChecked={configured.business_hours_only}
            name="businessHoursOnly"
            type="checkbox"
          />
          <span>
            <strong className="font-semibold text-ink">Business hours only</strong>
            <br />
            <span className="text-muted-foreground">
              If the nominal time is unavailable, Avenlyo moves it forward to the next valid local
              window.
            </span>
          </span>
        </label>
        <button
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          type="submit"
        >
          Save follow-up settings
        </button>
      </form>
    </section>
  );
}
