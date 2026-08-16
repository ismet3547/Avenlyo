'use server';

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  AgentTestServiceError,
  createAgentTestConversation,
  runAgentTestTurn,
} from '@/lib/agent/service';
import type { AgentTestTurn } from '@/lib/agent/types';
import { knowledgeServerEnv } from '@/lib/knowledge/config';
import { requireCompletedWorkspace } from '@/lib/onboarding/session';
import { getRequiredAuthContext } from '@/lib/supabase/auth';

export interface AgentTestActionState {
  readonly conversationId: string | null;
  readonly message?: string;
  readonly status: 'error' | 'idle' | 'success';
  readonly submittedMessage?: string;
  readonly turn?: AgentTestTurn;
}

async function getAgentTestContext() {
  const workspace = await requireCompletedWorkspace();
  if (workspace.role === 'member') return null;
  const auth = await getRequiredAuthContext();
  return auth ? { ...auth, workspace } : null;
}

function errorState(message: string, conversationId: string | null = null): AgentTestActionState {
  return { conversationId, message, status: 'error' };
}

export async function createAgentTestConversationAction(): Promise<AgentTestActionState> {
  if (!knowledgeServerEnv.OPENAI_API_KEY) {
    return errorState('OpenAI is not configured for this environment.');
  }
  const context = await getAgentTestContext();
  if (!context) return errorState('Only organization owners and admins can use Agent Test.');
  try {
    const conversationId = await createAgentTestConversation(context.supabase, context.workspace);
    return { conversationId, status: 'success' };
  } catch (error) {
    return errorState(
      error instanceof AgentTestServiceError
        ? error.message
        : 'A new test conversation could not be created.',
    );
  }
}

export async function sendAgentTestMessageAction(
  formData: FormData,
): Promise<AgentTestActionState> {
  const parsed = z
    .object({
      conversationId: z.string().uuid(),
      message: z.string().trim().min(1).max(4000),
    })
    .safeParse({
      conversationId: formData.get('conversationId'),
      message: formData.get('message'),
    });
  if (!parsed.success) return errorState('Enter a message up to 4,000 characters.');
  if (!knowledgeServerEnv.OPENAI_API_KEY) {
    return errorState('OpenAI is not configured for this environment.', parsed.data.conversationId);
  }
  const context = await getAgentTestContext();
  if (!context)
    return errorState(
      'Only organization owners and admins can use Agent Test.',
      parsed.data.conversationId,
    );
  try {
    const turn = await runAgentTestTurn(
      context.supabase,
      context.workspace,
      parsed.data.conversationId,
      parsed.data.message,
      randomUUID(),
    );
    return {
      conversationId: parsed.data.conversationId,
      status: 'success',
      submittedMessage: parsed.data.message,
      turn,
    };
  } catch (error) {
    return errorState(
      error instanceof AgentTestServiceError
        ? error.message
        : 'The Agent Test could not be completed.',
      parsed.data.conversationId,
    );
  }
}
