'use server';

import { industrySelectionSchema } from '@avenlyo/industries';
import {
  businessDetailsSchema,
  locationDetailsSchema,
  onboardingCompletionSchema,
  websitePreviewSchema,
} from '@avenlyo/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { z } from 'zod';

import type { FormActionState } from '@/lib/forms/state';
import { getOnboardingDestination } from '@/lib/onboarding/routing';
import {
  continueWebsitePreview,
  ensureWorkspaceContext,
  finishOnboarding,
  saveBusiness,
  saveIndustry,
  saveLocation,
} from '@/lib/onboarding/service';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

function invalidState(error: z.ZodError): FormActionState {
  return {
    status: 'error',
    message: 'Check the highlighted fields and try again.',
    fieldErrors: error.flatten().fieldErrors,
  };
}

function serviceErrorState(): FormActionState {
  return {
    status: 'error',
    message: 'This step could not be saved. Refresh the page and try again.',
  };
}

async function getAuthenticatedClient() {
  const auth = await getRequiredAuthContext();
  if (!auth) redirect('/auth/sign-in');
  return auth.supabase;
}

async function redirectToPersistedStep(
  supabase: Awaited<ReturnType<typeof getAuthenticatedClient>>,
) {
  const context = await ensureWorkspaceContext(supabase);
  revalidatePath('/onboarding');
  redirect(getOnboardingDestination(context));
}

export async function saveIndustryAction(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const result = industrySelectionSchema.safeParse({ industryId: formData.get('industryId') });
  if (!result.success) return invalidState(result.error);

  const supabase = await getAuthenticatedClient();
  try {
    await saveIndustry(supabase, result.data.industryId);
  } catch {
    return serviceErrorState();
  }

  await redirectToPersistedStep(supabase);
  return { status: 'success' };
}

export async function saveBusinessAction(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const result = businessDetailsSchema.safeParse({
    name: formData.get('name'),
    websiteUrl: formData.get('websiteUrl'),
    phone: formData.get('phone'),
  });
  if (!result.success) return invalidState(result.error);

  const supabase = await getAuthenticatedClient();
  try {
    await saveBusiness(supabase, result.data);
  } catch {
    return serviceErrorState();
  }

  await redirectToPersistedStep(supabase);
  return { status: 'success' };
}

export async function saveLocationAction(
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

  const supabase = await getAuthenticatedClient();
  try {
    await saveLocation(supabase, result.data);
  } catch {
    return serviceErrorState();
  }

  await redirectToPersistedStep(supabase);
  return { status: 'success' };
}

export async function continueWebsiteAction(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const result = websitePreviewSchema.safeParse({
    acknowledgement: formData.get('acknowledgement'),
  });
  if (!result.success) return invalidState(result.error);

  const supabase = await getAuthenticatedClient();
  try {
    await continueWebsitePreview(supabase);
  } catch {
    return serviceErrorState();
  }

  await redirectToPersistedStep(supabase);
  return { status: 'success' };
}

export async function completeOnboardingAction(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const result = onboardingCompletionSchema.safeParse({ intent: formData.get('intent') });
  if (!result.success) return invalidState(result.error);

  const supabase = await getAuthenticatedClient();
  try {
    await finishOnboarding(supabase);
  } catch {
    return serviceErrorState();
  }

  revalidatePath('/dashboard');
  redirect('/dashboard');
}
