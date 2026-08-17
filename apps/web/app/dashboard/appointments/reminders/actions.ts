'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { schedulingRpc } from '@/lib/scheduling/service';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

const reminderSettingsSchema = z
  .object({
    quietHoursEnd: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
    quietHoursStart: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
    reminder24hEnabled: z.string().optional(),
    reminder2hEnabled: z.string().optional(),
    smsEnabled: z.string().optional(),
  })
  .refine((value) => value.quietHoursStart !== value.quietHoursEnd, {
    message: 'Quiet-hours start and end must be different.',
  });

export async function saveAppointmentReminderSettingsAction(formData: FormData): Promise<void> {
  const workspace = await requireCompletedWorkspace();
  if (workspace.role === 'member' || !workspace.locationId) {
    throw new Error('Only organization owners and admins can manage reminders.');
  }
  const parsed = reminderSettingsSchema.parse({
    quietHoursEnd: formData.get('quietHoursEnd'),
    quietHoursStart: formData.get('quietHoursStart'),
    reminder24hEnabled: formData.get('reminder24hEnabled'),
    reminder2hEnabled: formData.get('reminder2hEnabled'),
    smsEnabled: formData.get('smsEnabled'),
  });
  const auth = await getRequiredAuthContext();
  if (!auth) throw new Error('Authentication is required.');
  const { error } = await schedulingRpc(auth.supabase)('upsert_my_appointment_reminder_settings', {
    target_24h_enabled: parsed.reminder24hEnabled === 'on',
    target_2h_enabled: parsed.reminder2hEnabled === 'on',
    target_location_id: workspace.locationId,
    target_quiet_hours_end: parsed.quietHoursEnd,
    target_quiet_hours_start: parsed.quietHoursStart,
    target_sms_enabled: parsed.smsEnabled === 'on',
  });
  if (error) throw new Error('Reminder settings could not be saved.');
  revalidatePath('/dashboard/appointments/reminders');
}
