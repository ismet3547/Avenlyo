'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { followupsRpc } from '@/lib/followups/service';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

const settingsSchema = z
  .object({
    acknowledgeSender: z.string().optional(),
    businessHoursOnly: z.string().optional(),
    delayMinutes: z.coerce.number().int().min(15).max(10_080),
    enabled: z.string().optional(),
    quietHoursEnd: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
    quietHoursStart: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
    senderPhoneNumberId: z.string().uuid().optional(),
  })
  .refine((value) => value.quietHoursStart !== value.quietHoursEnd, {
    message: 'Quiet-hours start and end must differ.',
  });

export async function saveLeadFollowupSettingsAction(formData: FormData): Promise<void> {
  const workspace = await requireCompletedWorkspace();
  if (workspace.role === 'member' || !workspace.locationId) {
    throw new Error('Only organization owners and admins can manage lead follow-ups.');
  }
  const value = settingsSchema.parse({
    acknowledgeSender: formData.get('acknowledgeSender'),
    businessHoursOnly: formData.get('businessHoursOnly'),
    delayMinutes: formData.get('delayMinutes'),
    enabled: formData.get('enabled'),
    quietHoursEnd: formData.get('quietHoursEnd'),
    quietHoursStart: formData.get('quietHoursStart'),
    senderPhoneNumberId: formData.get('senderPhoneNumberId') || undefined,
  });
  const auth = await getRequiredAuthContext();
  if (!auth) throw new Error('Authentication is required.');
  const { error } = await followupsRpc(auth.supabase)('upsert_my_lead_followup_settings', {
    target_acknowledge_sender: value.acknowledgeSender === 'on',
    target_business_hours_only: value.businessHoursOnly === 'on',
    target_delay_minutes: value.delayMinutes,
    target_enabled: value.enabled === 'on',
    target_location_id: workspace.locationId,
    target_quiet_hours_end: value.quietHoursEnd,
    target_quiet_hours_start: value.quietHoursStart,
    target_sender_phone_number_id: value.senderPhoneNumberId ?? null,
  });
  if (error) throw new Error('Lead follow-up settings could not be saved.');
  revalidatePath('/dashboard/leads/follow-ups');
}
