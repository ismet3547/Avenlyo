'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { messagingRpc } from '@/lib/messaging/service';

const widgetSchema = z.object({
  allowedOrigins: z.string().max(4000),
  enabled: z.boolean(),
  locationId: z.string().uuid(),
  welcomeMessage: z.string().trim().max(500),
});

export async function saveWebChatWidgetAction(formData: FormData): Promise<void> {
  const parsed = widgetSchema.safeParse({
    allowedOrigins: formData.get('allowedOrigins'),
    enabled: formData.get('enabled') === 'on',
    locationId: formData.get('locationId'),
    welcomeMessage: formData.get('welcomeMessage'),
  });
  const supabase = await createServerSupabaseClient();
  if (!parsed.success || !supabase) return;
  const origins = parsed.data.allowedOrigins
    .split(/[\n,]/)
    .map((origin) => origin.trim())
    .filter(Boolean);
  await messagingRpc(supabase)('upsert_my_web_chat_widget', {
    target_allowed_origins: origins,
    target_enabled: parsed.data.enabled,
    target_location_id: parsed.data.locationId,
    target_welcome_message: parsed.data.welcomeMessage || null,
  });
  revalidatePath('/dashboard/ai-front-office/web-chat');
}
