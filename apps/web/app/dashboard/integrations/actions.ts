'use server';

import { revalidatePath } from 'next/cache';
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
