'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

const appointmentIdSchema = z.string().uuid();
const instantSchema = z.string().datetime({ offset: true });

async function callStaffLifecycle(path: string, body?: Readonly<Record<string, string>>): Promise<void> {
  const auth = await getRequiredAuthContext();
  if (!auth) throw new Error('Authentication is required.');
  const { data } = await auth.supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error('Authentication is required.');
  const response = await fetch(`${process.env.AVENLYO_API_URL ?? 'http://localhost:4000'}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${data.session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store',
  });
  if (!response.ok) throw new Error('The appointment change could not be completed safely.');
}

/** Calls the authenticated API; provider credentials and lifecycle state never enter the browser. */
export async function cancelAppointmentAsStaffAction(formData: FormData): Promise<void> {
  const workspace = await requireCompletedWorkspace();
  if (workspace.role === 'member' || !workspace.locationId) {
    throw new Error('Only organization owners and admins can cancel appointments.');
  }
  const appointmentId = appointmentIdSchema.parse(formData.get('appointmentId'));
  await callStaffLifecycle(`/v1/scheduling/appointments/${workspace.locationId}/${appointmentId}/cancel`);
  revalidatePath('/dashboard/appointments');
}

export async function rescheduleAppointmentAsStaffAction(formData: FormData): Promise<void> {
  const workspace = await requireCompletedWorkspace();
  if (workspace.role === 'member' || !workspace.locationId) throw new Error('Only organization owners and admins can reschedule appointments.');
  const appointmentId = appointmentIdSchema.parse(formData.get('appointmentId'));
  const startsAt = instantSchema.parse(formData.get('startsAt'));
  const endsAt = instantSchema.parse(formData.get('endsAt'));
  await callStaffLifecycle(`/v1/scheduling/appointments/${workspace.locationId}/${appointmentId}/reschedule`, { endsAt, startsAt });
  revalidatePath('/dashboard/appointments');
}
