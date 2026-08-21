import type { KnowledgeSearchMatch } from '@/lib/knowledge/types';

/**
 * The knowledge action state, kept out of the `"use server"` module.
 *
 * A `"use server"` file declares a server-function boundary: every runtime value it exports becomes
 * a callable server reference, so Next.js refuses a module that exports anything else. The initial
 * state is an ordinary object shared with client components, so it belongs here. The type would be
 * erased and could have stayed, but keeping the pair together is what stops the object drifting
 * back into the action module the next time someone adds a field.
 */
export interface KnowledgeActionState {
  readonly matches?: readonly KnowledgeSearchMatch[];
  readonly message?: string;
  readonly status: 'error' | 'idle' | 'success';
}

export const knowledgeInitialActionState: KnowledgeActionState = { status: 'idle' };
