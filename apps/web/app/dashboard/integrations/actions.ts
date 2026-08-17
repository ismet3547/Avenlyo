'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { schedulingRpc } from '@/lib/scheduling/service';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

const connectionSchema = z.object({
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().trim().min(1).max(2_000),
  environment: z.enum(['production', 'trial']),
  siteUid: z.string().trim().min(1).max(500),
});

async function callSchedulingApi(
  path: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const auth = await getRequiredAuthContext();
  if (!auth) throw new Error('Authentication is required.');
  const { data } = await auth.supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error('Authentication is required.');
  const response = await fetch(`${process.env.AVENLYO_API_URL ?? 'http://localhost:4000'}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('ezyVet scheduling could not be updated.');
}

async function schedulingApiResponse(path: string): Promise<Response> {
  const auth = await getRequiredAuthContext();
  if (!auth) throw new Error('Authentication is required.');
  const { data } = await auth.supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error('Authentication is required.');
  return fetch(`${process.env.AVENLYO_API_URL ?? 'http://localhost:4000'}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store',
  });
}

async function requireManagerLocation(): Promise<string> {
  const workspace = await requireCompletedWorkspace();
  if (workspace.role === 'member' || !workspace.locationId)
    throw new Error('Only owners and admins can manage ezyVet.');
  return workspace.locationId;
}

export async function connectEzyVetAction(formData: FormData): Promise<void> {
  const locationId = await requireManagerLocation();
  const parsed = connectionSchema.parse({
    clientId: formData.get('clientId'),
    clientSecret: formData.get('clientSecret'),
    environment: formData.get('environment'),
    siteUid: formData.get('siteUid'),
  });
  await callSchedulingApi(`/v1/scheduling/ezyvet/${locationId}/connect`, parsed);
  revalidatePath('/dashboard/integrations');
}

export async function syncEzyVetCatalogAction(): Promise<void> {
  const locationId = await requireManagerLocation();
  await callSchedulingApi(`/v1/scheduling/ezyvet/${locationId}/catalog-sync`);
  revalidatePath('/dashboard/integrations');
}

export async function disconnectEzyVetAction(): Promise<void> {
  const locationId = await requireManagerLocation();
  await callSchedulingApi(`/v1/scheduling/ezyvet/${locationId}/disconnect`);
  revalidatePath('/dashboard/integrations');
}

function formString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

export async function connectGoogleCalendarAction(): Promise<never> {
  const locationId = await requireManagerLocation();
  const response = await schedulingApiResponse(`/v1/scheduling/google-calendar/${locationId}/connect`);
  const body = await response.json() as { authorizationUrl?: unknown };
  if (!response.ok || typeof body.authorizationUrl !== 'string') throw new Error('Google Calendar could not be connected.');
  redirect(body.authorizationUrl);
}

export async function discoverGoogleCalendarsAction(): Promise<void> {
  const locationId = await requireManagerLocation();
  const response = await schedulingApiResponse(`/v1/scheduling/google-calendar/${locationId}/discover`);
  if (!response.ok) throw new Error('Google Calendar discovery could not be refreshed.');
  revalidatePath('/dashboard/integrations');
}

export async function disconnectGoogleCalendarAction(): Promise<void> {
  const locationId = await requireManagerLocation();
  const response = await schedulingApiResponse(`/v1/scheduling/google-calendar/${locationId}/disconnect`);
  if (!response.ok) throw new Error('Google Calendar could not be disconnected.');
  revalidatePath('/dashboard/integrations');
}

export async function createGoogleAppointmentTypeAction(formData: FormData): Promise<void> {
  const locationId = await requireManagerLocation(); const auth = await getRequiredAuthContext();
  if (!auth) throw new Error('Authentication is required.');
  const { error } = await schedulingRpc(auth.supabase)('create_my_google_appointment_type', {
    target_duration_minutes: Number(formData.get('durationMinutes')), target_location_id: locationId, target_name: formString(formData.get('name')),
  });
  if (error) throw new Error('Google appointment type could not be created.');
  revalidatePath('/dashboard/integrations');
}

export async function saveGoogleBookingPolicyAction(formData: FormData): Promise<void> {
  const locationId = await requireManagerLocation(); const auth = await getRequiredAuthContext();
  if (!auth) throw new Error('Authentication is required.');
  const typeIds = formData.getAll('googleAppointmentTypeId').filter((value): value is string => typeof value === 'string');
  const resourceIds = formData.getAll('googleResourceId').filter((value): value is string => typeof value === 'string');
  const mappings = typeIds.flatMap((appointment_type_id) => resourceIds.map((resource_id) => ({ appointment_type_id, resource_id })));
  const integrationId = formString(formData.get('googleIntegrationId'));
  const { error } = await schedulingRpc(auth.supabase)('update_my_google_booking_policy', { mappings, selected_appointment_type_ids: typeIds, selected_resource_ids: resourceIds, target_location_id: locationId });
  if (error) throw new Error('Google Calendar booking policy could not be saved.');
  const lead = Number(formData.get('minimumLeadMinutes') ?? 60);
  const active = await schedulingRpc(auth.supabase)('set_my_active_scheduling_integration', { target_integration_id: integrationId, target_location_id: locationId, target_minimum_lead_minutes: lead });
  if (active.error) throw new Error('Active scheduling provider could not be saved.');
  revalidatePath('/dashboard/integrations');
}

export async function saveEzyVetBookablePolicyAction(formData: FormData): Promise<void> {
  const locationId = await requireManagerLocation();
  const auth = await getRequiredAuthContext();
  if (!auth) throw new Error('Authentication is required.');
  const selectedAppointmentTypeIds = formData
    .getAll('appointmentTypeId')
    .filter((value): value is string => typeof value === 'string');
  const selectedResourceIds = formData
    .getAll('resourceId')
    .filter((value): value is string => typeof value === 'string');
  const { error } = await schedulingRpc(auth.supabase)('update_my_ezyvet_booking_policy', {
    selected_appointment_type_ids: selectedAppointmentTypeIds,
    selected_resource_ids: selectedResourceIds,
    target_location_id: locationId,
  });
  if (error) throw new Error('Bookable policy could not be saved.');
  revalidatePath('/dashboard/integrations');
}
