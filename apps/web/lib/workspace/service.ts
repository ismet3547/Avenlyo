import { cookies } from 'next/headers';

import { z } from 'zod';

import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

import {
  WORKSPACE_SELECTION_COOKIE,
  parseWorkspaceSelection,
  toWorkspaceOption,
  workspaceOptionKey,
  type WorkspaceOption,
  type WorkspaceSelection,
} from './selection';

/**
 * Server-side workspace selection.
 *
 * The cookie is set by the server, HttpOnly so page scripts cannot read or forge it, and it holds
 * nothing but a context key. Role is never stored there: it can change, and a cookie that outlived
 * a demotion would be a privilege the database never granted.
 */

const workspaceRowSchema = z.object({
  organization_id: z.string().uuid(),
  organization_name: z.string(),
  membership_id: z.string().uuid(),
  membership_role: z.enum(['owner', 'admin', 'member']),
  location_id: z.string().uuid().nullable(),
  location_name: z.string().nullable(),
  onboarding_status: z.enum(['in_progress', 'completed']).nullable(),
  onboarding_step: z
    .enum(['industry', 'business', 'location', 'website', 'review', 'completed'])
    .nullable(),
});

interface WorkspaceRpcCaller {
  (name: 'get_my_workspace_contexts'): PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
  }>;
}

function workspaceRpc(client: AvenlyoSupabaseClient): WorkspaceRpcCaller {
  return client.rpc.bind(client);
}

export class WorkspaceServiceError extends Error {
  public constructor() {
    super('The workspace context could not be loaded.');
    this.name = 'WorkspaceServiceError';
  }
}

/** Every context this caller may work in right now, straight from the database. */
export async function loadWorkspaceOptions(
  supabase: AvenlyoSupabaseClient,
): Promise<WorkspaceOption[]> {
  const { data, error } = await workspaceRpc(supabase)('get_my_workspace_contexts');
  if (error || data === null) {
    throw new WorkspaceServiceError();
  }
  return z
    .array(workspaceRowSchema)
    .parse(data)
    .map((row) => toWorkspaceOption(row));
}

export async function readWorkspaceSelection(): Promise<WorkspaceSelection | null> {
  const store = await cookies();
  return parseWorkspaceSelection(store.get(WORKSPACE_SELECTION_COOKIE)?.value ?? null);
}

/**
 * Records a preference the caller has already been proven to hold. Callers must validate the
 * option against `loadWorkspaceOptions` first; this function only writes.
 */
export async function writeWorkspaceSelection(selection: WorkspaceSelection): Promise<void> {
  const store = await cookies();
  store.set(WORKSPACE_SELECTION_COOKIE, workspaceOptionKey(selection), {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

export async function clearWorkspaceSelection(): Promise<void> {
  const store = await cookies();
  store.delete(WORKSPACE_SELECTION_COOKIE);
}
