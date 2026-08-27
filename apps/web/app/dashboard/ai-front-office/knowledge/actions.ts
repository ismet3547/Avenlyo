'use server';

import { normalizeCrawlUrl } from '@avenlyo/knowledge';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import {
  KnowledgeServiceError,
  publishKnowledgeImport,
  requestWebsiteImport,
  saveKnowledgeDraft,
  searchKnowledge,
} from '@/lib/knowledge/service';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

import type { KnowledgeActionState } from './action-state';

function errorState(message: string): KnowledgeActionState {
  return { message, status: 'error' };
}

async function getKnowledgeActionContext() {
  const workspace = await requireCompletedWorkspace();
  if (workspace.role === 'member') {
    return null;
  }
  const auth = await getRequiredAuthContext();
  return auth ? { ...auth, workspace } : null;
}

export async function startKnowledgeImportAction(
  _previous: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  const parsed = z.object({ rootUrl: z.string().trim().min(1).max(2048) }).safeParse({
    rootUrl: formData.get('rootUrl'),
  });
  if (!parsed.success) return errorState('Enter a public website URL.');
  try {
    normalizeCrawlUrl(parsed.data.rootUrl);
  } catch (error) {
    return errorState(error instanceof Error ? error.message : 'Enter a public website URL.');
  }

  const context = await getKnowledgeActionContext();
  if (!context) return errorState('Only organization owners and admins can import knowledge.');

  // Queueing only. The crawl belongs to the API worker, so this action returns as soon as the
  // request is durable and the operator watches it progress on the review page.
  //
  // Only the queueing is inside the error boundary. `redirect` reports success by throwing a
  // control signal, so leaving it in the try turned every successful request into a knowledge
  // error and stranded the operator on the form with a message about work that had actually
  // started.
  let importId: string;
  try {
    importId = await requestWebsiteImport(
      context.supabase,
      parsed.data.rootUrl,
      context.workspace.locationId,
    );
  } catch (error) {
    return errorState(
      error instanceof KnowledgeServiceError
        ? error.message
        : 'This website import could not be started.',
    );
  }

  revalidatePath('/dashboard/ai-front-office/knowledge');
  redirect(`/dashboard/ai-front-office/knowledge/imports/${importId}`);
}

export async function updateKnowledgeDraftAction(
  _previous: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  const parsed = z
    .object({
      content: z.string().trim().min(40).max(1_000_000),
      documentId: z.string().uuid(),
      importId: z.string().uuid(),
      included: z.string().optional(),
      title: z.string().trim().min(1).max(240),
    })
    .safeParse({
      content: formData.get('content'),
      documentId: formData.get('documentId'),
      importId: formData.get('importId'),
      included: formData.get('included'),
      title: formData.get('title'),
    });
  if (!parsed.success) return errorState('Add a title and at least 40 characters of useful text.');
  const context = await getKnowledgeActionContext();
  if (!context) return errorState('Only organization owners and admins can edit knowledge.');
  try {
    await saveKnowledgeDraft(
      context.supabase,
      parsed.data.documentId,
      parsed.data.title,
      parsed.data.content,
      parsed.data.included === 'on',
    );
    revalidatePath(`/dashboard/ai-front-office/knowledge/imports/${parsed.data.importId}`);
    return { message: 'Draft saved.', status: 'success' };
  } catch {
    return errorState('This draft could not be saved. Refresh and try again.');
  }
}

export async function publishKnowledgeImportAction(
  _previous: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  const parsed = z
    .object({ importId: z.string().uuid() })
    .safeParse({ importId: formData.get('importId') });
  if (!parsed.success) return errorState('Knowledge import is invalid.');
  const context = await getKnowledgeActionContext();
  if (!context) return errorState('Only organization owners and admins can publish knowledge.');
  try {
    await publishKnowledgeImport(context.supabase, parsed.data.importId);
    revalidatePath('/dashboard/ai-front-office/knowledge');
    revalidatePath(`/dashboard/ai-front-office/knowledge/imports/${parsed.data.importId}`);
    return { message: 'Knowledge published.', status: 'success' };
  } catch (error) {
    return errorState(
      error instanceof KnowledgeServiceError
        ? error.message
        : 'Knowledge could not be published right now. Please try again.',
    );
  }
}

export async function searchKnowledgeAction(
  _previous: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  const parsed = z.object({ question: z.string().trim().min(3).max(1000) }).safeParse({
    question: formData.get('question'),
  });
  if (!parsed.success) return errorState('Enter a question with at least three characters.');
  const context = await getKnowledgeActionContext();
  if (!context) return errorState('Only organization owners and admins can test knowledge.');
  try {
    const matches = await searchKnowledge(
      context.supabase,
      parsed.data.question,
      context.workspace.locationId,
    );
    return { matches, status: 'success' };
  } catch (error) {
    return errorState(
      error instanceof KnowledgeServiceError
        ? error.message
        : 'Knowledge search could not be completed right now.',
    );
  }
}
