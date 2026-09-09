'use server';

import { businessDetailsSchema, locationDetailsSchema } from '@avenlyo/shared';
import { revalidatePath } from 'next/cache';
import type { z } from 'zod';

import type { FormActionState } from '@/lib/forms/state';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import {
  updateBusinessSettings,
  updateLocationSettings,
} from '@/lib/settings/business-location-service';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

function invalidState(error: z.ZodError): FormActionState {
  return {
    status: 'error',
    message: 'Check the highlighted fields and try again.',
    fieldErrors: error.flatten().fieldErrors,
  };
}

function unavailableState(): FormActionState {
  return {
    status: 'error',
    message: 'These settings could not be saved. Refresh the page and try again.',
  };
}

function accessState(): FormActionState {
  return {
    status: 'error',
    message: 'Owner or admin access is required to change business settings.',
  };
}

function canManage(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

function revalidateSettings() {
  revalidatePath('/dashboard');
  revalidatePath('/dashboard/settings');
  revalidatePath('/dashboard/settings/business');
  revalidatePath('/dashboard/ai-front-office');
}

export async function saveBusinessSettingsAction(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const result = businessDetailsSchema.safeParse({
    name: formData.get('name'),
    websiteUrl: formData.get('websiteUrl'),
    phone: formData.get('phone'),
  });
  if (!result.success) return invalidState(result.error);

  const workspace = await requireCompletedWorkspace();
  if (!canManage(workspace.role)) return accessState();
  const auth = await getRequiredAuthContext();
  if (!auth) return unavailableState();

  try {
    await updateBusinessSettings(auth.supabase, workspace.organizationId, result.data);
  } catch {
    return unavailableState();
  }

  revalidateSettings();
  return { status: 'success', message: 'Business details saved.' };
}

export async function saveLocationSettingsAction(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  let businessHours: unknown;
  const serializedBusinessHours = formData.get('businessHours');
  try {
    businessHours =
      typeof serializedBusinessHours === 'string' ? JSON.parse(serializedBusinessHours) : null;
  } catch {
    businessHours = null;
  }

  const result = locationDetailsSchema.safeParse({
    name: formData.get('name'),
    street: formData.get('street'),
    city: formData.get('city'),
    region: formData.get('region'),
    postalCode: formData.get('postalCode'),
    countryCode: formData.get('countryCode'),
    timezone: formData.get('timezone'),
    businessHours,
  });
  if (!result.success) return invalidState(result.error);

  const workspace = await requireCompletedWorkspace();
  if (!canManage(workspace.role)) return accessState();
  if (!workspace.locationId) return unavailableState();
  const auth = await getRequiredAuthContext();
  if (!auth) return unavailableState();

  try {
    await updateLocationSettings(
      auth.supabase,
      workspace.organizationId,
      workspace.locationId,
      result.data,
    );
  } catch {
    return unavailableState();
  }

  revalidateSettings();
  return { status: 'success', message: 'Location details and business hours saved.' };
}
