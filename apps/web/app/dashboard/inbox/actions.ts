'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { messagingRpc } from '@/lib/messaging/service';

const identifierSchema = z.string().uuid();
const replySchema = z.object({
  body: z.string().trim().min(1).max(2000),
  conversationId: z.string().uuid(),
});

const SILENT_OUTCOMES = new Set(['claimed', 'released', 'resolved', 'sent', 'taken_over']);

/**
 * Every operator action returns to the queue row it acted on, carrying only a bounded outcome
 * code. Conflicts are never invented in the client: the RPC result is the authority.
 */
function backToInbox(conversationId: string | null, outcome: string | null): never {
  const params = new URLSearchParams();
  if (conversationId) params.set('conversation', conversationId);
  if (outcome && !SILENT_OUTCOMES.has(outcome)) params.set('outcome', outcome);
  const query = params.toString();
  revalidatePath('/dashboard/inbox');
  redirect(query ? `/dashboard/inbox?${query}` : '/dashboard/inbox');
}

async function callHandoffRpc(
  name: 'claim_my_handoff' | 'release_my_handoff' | 'resolve_my_handoff',
  formData: FormData,
): Promise<never> {
  const handoff = identifierSchema.safeParse(formData.get('handoffId'));
  const conversation = identifierSchema.safeParse(formData.get('conversationId'));
  const conversationId = conversation.success ? conversation.data : null;
  const supabase = await createServerSupabaseClient();
  if (!handoff.success || !supabase) return backToInbox(conversationId, 'unavailable');
  const rpc = messagingRpc(supabase);
  const args = { target_handoff_id: handoff.data };
  const result =
    name === 'claim_my_handoff'
      ? await rpc('claim_my_handoff', args)
      : name === 'release_my_handoff'
        ? await rpc('release_my_handoff', args)
        : await rpc('resolve_my_handoff', args);
  if (result.error) return backToInbox(conversationId, 'unavailable');
  return backToInbox(conversationId, result.data?.[0]?.outcome ?? 'unavailable');
}

export async function claimHandoffAction(formData: FormData): Promise<never> {
  return callHandoffRpc('claim_my_handoff', formData);
}

export async function releaseHandoffAction(formData: FormData): Promise<never> {
  return callHandoffRpc('release_my_handoff', formData);
}

export async function resolveHandoffAction(formData: FormData): Promise<never> {
  return callHandoffRpc('resolve_my_handoff', formData);
}

export async function takeOverConversationAction(formData: FormData): Promise<never> {
  const parsed = identifierSchema.safeParse(formData.get('conversationId'));
  const supabase = await createServerSupabaseClient();
  if (!parsed.success || !supabase) return backToInbox(null, 'unavailable');
  const { data, error } = await messagingRpc(supabase)('take_over_my_conversation', {
    target_conversation_id: parsed.data,
  });
  if (error) return backToInbox(parsed.data, 'unavailable');
  return backToInbox(parsed.data, data?.[0]?.outcome ?? 'unavailable');
}

export async function resumeConversationAction(formData: FormData): Promise<never> {
  const parsed = identifierSchema.safeParse(formData.get('conversationId'));
  const supabase = await createServerSupabaseClient();
  if (!parsed.success || !supabase) return backToInbox(null, 'unavailable');
  const { data, error } = await messagingRpc(supabase)('resume_my_conversation_ai', {
    target_conversation_id: parsed.data,
  });
  if (error) return backToInbox(parsed.data, 'unavailable');
  return backToInbox(parsed.data, data?.[0]?.outcome ?? 'unavailable');
}

export async function sendHumanReplyAction(formData: FormData): Promise<never> {
  const fallback = identifierSchema.safeParse(formData.get('conversationId'));
  const conversationId = fallback.success ? fallback.data : null;
  const parsed = replySchema.safeParse({
    body: formData.get('body'),
    conversationId: formData.get('conversationId'),
  });
  const supabase = await createServerSupabaseClient();
  if (!parsed.success || !supabase) return backToInbox(conversationId, 'unavailable');
  const { data, error } = await messagingRpc(supabase)('create_my_human_reply', {
    target_body: parsed.data.body,
    target_conversation_id: parsed.data.conversationId,
  });
  if (error) return backToInbox(parsed.data.conversationId, 'reply_failed');
  return backToInbox(parsed.data.conversationId, data?.[0]?.outcome ?? 'unavailable');
}
