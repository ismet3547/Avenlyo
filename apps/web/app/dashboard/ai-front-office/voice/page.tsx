import { PhoneCall, Radio, ShieldCheck, UserRoundCheck } from 'lucide-react';

import { VoiceConfigurationForm } from '@/components/voice/voice-configuration-form';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';
import { loadRecentVoiceCalls, loadVoiceConfiguration } from '@/lib/voice/service';

function formatDate(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';
}

function duration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt || !endedAt) return 'In progress';
  const seconds = Math.max(
    0,
    Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000),
  );
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default async function VoicePage() {
  const workspace = await requireCompletedWorkspace();
  const canManage = workspace.role === 'owner' || workspace.role === 'admin';
  const auth = await getRequiredAuthContext();
  const locationId = workspace.locationId;
  const [configuration, calls] =
    canManage && auth && locationId
      ? await Promise.all([
          loadVoiceConfiguration(auth.supabase, locationId),
          loadRecentVoiceCalls(auth.supabase, locationId),
        ])
      : [null, []];

  if (!canManage) {
    return (
      <section className="max-w-3xl">
        <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          AI Front Office / Voice
        </p>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
          Voice is owner/admin-only
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Ask an organization owner or admin to review inbound voice configuration and calls.
        </p>
      </section>
    );
  }

  return (
    <section className="max-w-5xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        AI Front Office / Voice
      </p>
      <div className="mt-3 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
            Inbound Voice
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Avenlyo handles live speech through OpenAI Realtime SIP. Your API stays on the control
            plane for tenant routing, approved knowledge, transcripts, and human handoff.
          </p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-900">
          <Radio aria-hidden="true" className="size-3.5" /> Direct SIP control plane
        </div>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <article className="rounded-xl border border-border bg-white p-5 shadow-sm">
          <PhoneCall aria-hidden="true" className="size-5 text-primary" />
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Assigned number
          </p>
          <p className="mt-1 font-mono text-lg font-semibold text-ink">
            {configuration?.assignedPhoneNumber ?? 'Not assigned'}
          </p>
        </article>
        <article className="rounded-xl border border-border bg-white p-5 shadow-sm">
          <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Voice status
          </p>
          <p className="mt-1 text-lg font-semibold capitalize text-ink">
            {configuration?.enabled ? 'Enabled' : 'Disabled'}
          </p>
        </article>
        <article className="rounded-xl border border-border bg-white p-5 shadow-sm">
          <UserRoundCheck aria-hidden="true" className="size-5 text-primary" />
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Human transfer
          </p>
          <p className="mt-1 text-lg font-semibold text-ink">
            {configuration?.transferEnabled && configuration.providerTransferEnabled
              ? 'Available'
              : configuration?.transferEnabled
                ? 'Awaiting trunk setup'
                : 'Disabled'}
          </p>
        </article>
      </div>

      {!locationId ? (
        <p className="mt-6 rounded-xl border border-border bg-white p-4 text-sm text-muted-foreground shadow-sm">
          Choose a workspace location before configuring inbound voice.
        </p>
      ) : (
        <section className="mt-6 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-lg font-semibold text-ink">Voice configuration</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Voice is configured for {workspace.locationName ?? 'this location'}. The Realtime model
            is server-managed; no provider credentials are exposed here.
          </p>
          <VoiceConfigurationForm configuration={configuration} />
        </section>
      )}

      <section className="mt-6 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold text-ink">Recent calls</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Real persisted customer calls for this location.
        </p>
        {calls.length ? (
          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-semibold">Caller</th>
                  <th className="px-3 py-2 font-semibold">Started</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Duration</th>
                  <th className="px-3 py-2 font-semibold">Handoff</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {calls.map((call) => (
                  <tr key={call.id}>
                    <td className="px-3 py-3 font-mono text-xs text-ink">
                      {call.callerPhone ?? 'Private caller'}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {formatDate(call.startedAt)}
                    </td>
                    <td className="px-3 py-3 capitalize text-ink">
                      {call.status.replaceAll('_', ' ')}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {duration(call.startedAt, call.endedAt)}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {call.handoffRequested ? 'Requested' : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-5 text-sm leading-6 text-muted-foreground">
            No inbound calls have been persisted for this location yet.
          </p>
        )}
      </section>
    </section>
  );
}
