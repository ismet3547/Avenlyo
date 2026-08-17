'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { messagingRpc } from '@/lib/messaging/service';

const conversationSchema = z.string().uuid();
const replySchema = z.object({
  body: z.string().trim().min(1).max(2000),
  conversationId: z.string().uuid(),
});

async function callConversationRpc(
  name: 'take_over_my_conversation' | 'resume_my_conversation_ai',
  conversationId: FormDataEntryValue | null,
): Promise<void> {
  const parsed = conversationSchema.safeParse(conversationId);
  const supabase = await createServerSupabaseClient();
  if (!parsed.success || !supabase) return;
  await messagingRpc(supabase)(name, { target_conversation_id: parsed.data });
  revalidatePath('/dashboard/inbox');
}

export async function takeOverConversationAction(formData: FormData): Promise<void> {
  await callConversationRpc('take_over_my_conversation', formData.get('conversationId'));
}

export async function resumeConversationAction(formData: FormData): Promise<void> {
  await callConversationRpc('resume_my_conversation_ai', formData.get('conversationId'));
}

export async function sendHumanReplyAction(formData: FormData): Promise<void> {
  const parsed = replySchema.safeParse({
    body: formData.get('body'),
    conversationId: formData.get('conversationId'),
  });
  const supabase = await createServerSupabaseClient();
  if (!parsed.success || !supabase) return;
  await messagingRpc(supabase)('create_my_human_reply', {
    target_body: parsed.data.body,
    target_conversation_id: parsed.data.conversationId,
  });
  revalidatePath('/dashboard/inbox');
}
