import {
  connectEzyVetAction,
  connectGoogleCalendarAction,
  createGoogleAppointmentTypeAction,
  discoverGoogleCalendarsAction,
  disconnectGoogleCalendarAction,
  disconnectEzyVetAction,
  saveGoogleBookingPolicyAction,
  saveEzyVetBookablePolicyAction,
  syncEzyVetCatalogAction,
} from './actions';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { schedulingRpc, type EzyVetConfigurationRow, type GoogleCalendarConfigurationRow } from '@/lib/scheduling/service';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

type ConfigurationRow = EzyVetConfigurationRow;

function formatDate(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : 'Not synced yet';
}

export default async function IntegrationsPage() {
  const workspace = await requireCompletedWorkspace();
  const auth = await getRequiredAuthContext();
  const canManage = workspace.role === 'owner' || workspace.role === 'admin';
  const locationId = workspace.locationId;
  const rows: readonly ConfigurationRow[] =
    auth && locationId
      ? ((
          await schedulingRpc(auth.supabase)('get_my_ezyvet_integration_configuration', {
            target_location_id: locationId,
          })
        ).data ?? [])
      : [];
  const integration = rows[0] ?? null;
  const googleRows: readonly GoogleCalendarConfigurationRow[] = auth && locationId
    ? ((await schedulingRpc(auth.supabase)('get_my_google_scheduling_configuration', { target_location_id: locationId })).data ?? [])
    : [];
  const google = googleRows[0] ?? null;
  const googleTypes = new Map<string, GoogleCalendarConfigurationRow>();
  const googleResources = new Map<string, GoogleCalendarConfigurationRow>();
  for (const row of googleRows) {
    if (row.appointment_type_id) googleTypes.set(row.appointment_type_id, row);
    if (row.resource_id) googleResources.set(row.resource_id, row);
  }
  const types = new Map<string, ConfigurationRow>();
  const resources = new Map<string, ConfigurationRow>();
  for (const row of rows) {
    if (row.appointment_type_id) types.set(row.appointment_type_id, row);
    if (row.resource_id) resources.set(row.resource_id, row);
  }

  if (!canManage) {
    return (
      <section className="max-w-3xl">
        <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          Integrations
        </p>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink">
          Integrations are owner/admin-only
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Ask an owner or admin to configure scheduling for this location.
        </p>
      </section>
    );
  }

  return (
    <section className="max-w-4xl">
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Integrations / ezyVet
      </p>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        Veterinary scheduling
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        Connect this location to ezyVet, choose what the AI may offer, and keep confirmation and
        booking entirely on the trusted backend.
      </p>

      <section className="mt-8 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold text-ink">Connection</h2>
        {integration?.status === 'connected' ? (
          <div className="mt-4 space-y-3 text-sm text-muted-foreground">
            <p>
              Connected to {integration.environment ?? 'ezyVet'} · timezone:{' '}
              {integration.site_timezone ?? 'needs attention'}.
            </p>
            <p>Catalog last synced: {formatDate(integration.last_catalog_synced_at)}.</p>
            <div className="flex flex-wrap gap-3">
              <form action={syncEzyVetCatalogAction}>
                <button
                  className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white"
                  type="submit"
                >
                  Sync catalog
                </button>
              </form>
              <form action={disconnectEzyVetAction}>
                <button
                  className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-ink"
                  type="submit"
                >
                  Disconnect
                </button>
              </form>
            </div>
          </div>
        ) : (
          <form action={connectEzyVetAction} className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium text-ink">
              Environment
              <select
                className="mt-2 block w-full rounded-lg border border-border bg-white px-3 py-2"
                defaultValue="trial"
                name="environment"
              >
                <option value="trial">Trial</option>
                <option value="production">Production</option>
              </select>
            </label>
            <label className="text-sm font-medium text-ink">
              Site UID
              <input
                className="mt-2 block w-full rounded-lg border border-border px-3 py-2"
                name="siteUid"
                required
              />
            </label>
            <label className="text-sm font-medium text-ink">
              Client ID
              <input
                className="mt-2 block w-full rounded-lg border border-border px-3 py-2"
                name="clientId"
                required
              />
            </label>
            <label className="text-sm font-medium text-ink">
              Client secret
              <input
                className="mt-2 block w-full rounded-lg border border-border px-3 py-2"
                name="clientSecret"
                required
                type="password"
              />
            </label>
            <p className="sm:col-span-2 text-xs leading-5 text-muted-foreground">
              The secret is submitted once to the server and stored only as a Supabase Vault
              reference. It is never shown again.
            </p>
            <button
              className="w-fit rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white"
              type="submit"
            >
              Connect ezyVet
            </button>
          </form>
        )}
      </section>

      {integration?.status === 'connected' ? (
        <section className="mt-6 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-lg font-semibold text-ink">Bookable policy</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Only selected active types and calendar resources can be offered by inbound voice.
          </p>
          <form action={saveEzyVetBookablePolicyAction} className="mt-5 grid gap-6 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-ink">Appointment types</h3>
              <div className="mt-3 space-y-2">
                {[...types.values()].map((row) => (
                  <label className="flex items-center gap-2 text-sm" key={row.appointment_type_id}>
                    <input
                      defaultChecked={row.appointment_type_bookable ?? false}
                      disabled={!row.appointment_type_active}
                      name="appointmentTypeId"
                      type="checkbox"
                      value={row.appointment_type_id ?? ''}
                    />
                    <span>{row.appointment_type_name ?? 'Unnamed type'}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-ink">Resources</h3>
              <div className="mt-3 space-y-2">
                {[...resources.values()].map((row) => (
                  <label className="flex items-center gap-2 text-sm" key={row.resource_id}>
                    <input
                      defaultChecked={row.resource_bookable ?? false}
                      disabled={!row.resource_active}
                      name="resourceId"
                      type="checkbox"
                      value={row.resource_id ?? ''}
                    />
                    <span>{row.resource_name ?? 'Unnamed resource'}</span>
                  </label>
                ))}
              </div>
            </div>
            <button
              className="w-fit rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white"
              type="submit"
            >
              Save bookable policy
            </button>
          </form>
        </section>
      ) : null}

      <section className="mt-6 rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
        <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          Google Calendar
        </p>
        <h2 className="mt-2 text-lg font-semibold text-ink">Provider-neutral scheduling</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Google Calendar contributes availability and one normal event after caller confirmation. It is not a customer database.
        </p>
        {google?.status === 'connected' ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-muted-foreground">Connected · last verified {formatDate(google.last_verified_at)}{google.is_active ? ' · active scheduling provider' : ''}.</p>
            <div className="flex flex-wrap gap-3">
              <form action={discoverGoogleCalendarsAction}><button className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white" type="submit">Refresh writable calendars</button></form>
              <form action={disconnectGoogleCalendarAction}><button className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-ink" type="submit">Disconnect</button></form>
            </div>
            <form action={createGoogleAppointmentTypeAction} className="grid gap-3 border-t border-border pt-4 sm:grid-cols-3">
              <input className="rounded-lg border border-border px-3 py-2 text-sm" name="name" placeholder="Consultation" required />
              <input className="rounded-lg border border-border px-3 py-2 text-sm" defaultValue="30" max="360" min="10" name="durationMinutes" required step="5" type="number" />
              <button className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-ink" type="submit">Add appointment type</button>
            </form>
            <form action={saveGoogleBookingPolicyAction} className="grid gap-5 border-t border-border pt-4 sm:grid-cols-2">
              <input name="googleIntegrationId" type="hidden" value={google.integration_id ?? ''} />
              <label className="text-sm font-medium text-ink">Minimum lead minutes<input className="mt-2 block w-full rounded-lg border border-border px-3 py-2" defaultValue={google.minimum_lead_minutes ?? 60} max="1440" min="15" name="minimumLeadMinutes" step="15" type="number" /></label>
              <div className="text-sm font-medium text-ink">Appointment types<div className="mt-2 space-y-2 font-normal">{[...googleTypes.values()].map((row) => <label className="flex items-center gap-2" key={row.appointment_type_id}><input defaultChecked={row.appointment_type_bookable ?? false} name="googleAppointmentTypeId" type="checkbox" value={row.appointment_type_id ?? ''}/>{row.appointment_type_name} · {row.appointment_type_duration_minutes} min</label>)}</div></div>
              <div className="text-sm font-medium text-ink">Writable calendars<div className="mt-2 space-y-2 font-normal">{[...googleResources.values()].map((row) => <label className="flex items-center gap-2" key={row.resource_id}><input defaultChecked={row.resource_bookable ?? false} name="googleResourceId" type="checkbox" value={row.resource_id ?? ''}/>{row.resource_name} · {row.resource_access_role}</label>)}</div></div>
              <button className="w-fit rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white" type="submit">Save policy and make active</button>
            </form>
          </div>
        ) : (
          <form action={connectGoogleCalendarAction} className="mt-4"><button className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white" type="submit">Connect Google Calendar</button></form>
        )}
      </section>
    </section>
  );
}
