'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';
import { saveVoiceConfiguration, VoiceConfigurationError } from '@/lib/voice/service';

import type { VoiceConfigurationActionState } from './action-state';

const voiceSchema = z.enum([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
]);
const e164Schema = z.string().regex(/^\+[1-9][0-9]{7,14}$/);

export async function saveVoiceConfigurationAction(
  _previous: VoiceConfigurationActionState,
  formData: FormData,
): Promise<VoiceConfigurationActionState> {
  const parsed = z
    .object({
      enabled: z.string().optional(),
      transferEnabled: z.string().optional(),
      transferTargetE164: z.string().trim().max(16),
      voice: voiceSchema,
    })
    .safeParse({
      enabled: formData.get('enabled'),
      transferEnabled: formData.get('transferEnabled'),
      transferTargetE164: formData.get('transferTargetE164'),
      voice: formData.get('voice'),
    });
  if (!parsed.success)
    return { message: 'Choose a supported voice and a valid phone number.', status: 'error' };
  const transferEnabled = parsed.data.transferEnabled === 'on';
  if (transferEnabled && !e164Schema.safeParse(parsed.data.transferTargetE164).success) {
    return {
      message: 'Enter a canonical human transfer number, for example +14155550123.',
      status: 'error',
    };
  }
  const workspace = await requireCompletedWorkspace();
  if (workspace.role === 'member' || !workspace.locationId) {
    return { message: 'Only organization owners and admins can manage Voice.', status: 'error' };
  }
  const auth = await getRequiredAuthContext();
  if (!auth) return { message: 'Sign in to update Voice.', status: 'error' };
  try {
    await saveVoiceConfiguration(auth.supabase, {
      enabled: parsed.data.enabled === 'on',
      locationId: workspace.locationId,
      transferEnabled,
      transferTargetE164: transferEnabled ? parsed.data.transferTargetE164 : '',
      voice: parsed.data.voice,
    });
    revalidatePath('/dashboard/ai-front-office/voice');
    return { message: 'Voice configuration saved.', status: 'success' };
  } catch (error) {
    return {
      message:
        error instanceof VoiceConfigurationError
          ? error.message
          : 'Voice settings could not be updated.',
      status: 'error',
    };
  }
}
