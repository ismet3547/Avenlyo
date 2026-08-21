import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as KnowledgeService from '@/lib/knowledge/service';
import { describe, expect, it, vi } from 'vitest';

const importWebsiteKnowledge = vi.fn();
const redirect = vi.fn((url: string) => {
  // Next's real redirect signals success by throwing a control-flow error rather than returning.
  // Reproducing that shape is what makes this test able to catch a redirect swallowed by a catch.
  const error = new Error('NEXT_REDIRECT') as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${url};307;`;
  throw error;
});
const revalidatePath = vi.fn();

vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('@/lib/onboarding/session', () => ({
  requireCompletedWorkspace: vi.fn(() =>
    Promise.resolve({ locationId: '10000000-0000-4000-8000-000000000001', role: 'owner' }),
  ),
}));
vi.mock('@/lib/supabase/auth', () => ({
  getRequiredAuthContext: vi.fn(() => Promise.resolve({ supabase: {} })),
}));
vi.mock('@/lib/knowledge/service', async (importOriginal) => ({
  ...(await importOriginal<typeof KnowledgeService>()),
  importWebsiteKnowledge,
}));
vi.mock('@/lib/knowledge/config', () => ({
  knowledgeServerEnv: { OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small' },
}));

const actions = await import('./actions');
const { KnowledgeServiceError } = await import('@/lib/knowledge/service');
const { knowledgeInitialActionState } = await import('./action-state');

function form(rootUrl: string): FormData {
  const data = new FormData();
  data.set('rootUrl', rootUrl);
  return data;
}

function isRedirect(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as Error & { digest?: unknown }).digest === 'string' &&
    (error as Error & { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

/**
 * A `"use server"` module is a server-function boundary: Next.js turns every runtime export into a
 * callable server reference and refuses the module outright when one is not a function. Exporting
 * the initial action state broke `POST /dashboard/ai-front-office/knowledge` in dev with
 * `A "use server" file can only export async functions, found object.`
 */
describe('the server-action module exports only server actions', () => {
  it('exposes nothing at runtime except async functions', () => {
    const exported = Object.entries(actions);
    expect(exported.length).toBeGreaterThan(0);
    for (const [name, value] of exported) {
      expect(typeof value, `${name} must be a function`).toBe('function');
      expect((value as () => unknown).constructor.name, `${name} must be async`).toBe(
        'AsyncFunction',
      );
    }
  });

  it('does not re-export the initial state, which lives in a plain module', () => {
    expect(Object.keys(actions)).not.toContain('knowledgeInitialActionState');
    expect(knowledgeInitialActionState).toEqual({ status: 'idle' });
  });
});

/** The same violation class anywhere else in the app would fail the build the same way. */
describe('no other "use server" module exports a runtime value', () => {
  const root = fileURLToPath(new URL('../../../..', import.meta.url));

  function serverActionModules(): readonly string[] {
    const found: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        if (entry === 'node_modules' || entry === '.next') continue;
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        const text = readFileSync(path, 'utf8').split('\r\n').join('\n');
        if (/^\s*['"]use server['"]\s*;/m.test(text)) found.push(path);
      }
    };
    walk(root);
    return found;
  }

  it('finds server-action modules and none of them export a non-function value', () => {
    const modules = serverActionModules();
    expect(modules.length).toBeGreaterThan(5);
    for (const path of modules) {
      const text = readFileSync(path, 'utf8').split('\r\n').join('\n');
      // `export interface` and `export type` are erased before Next sees the module; anything else
      // exported from a server-action file becomes a runtime value.
      const offending = text
        .split('\n')
        .filter((line) => /^export (const|let|var|class|enum|function|default)\b/.test(line))
        .filter((line) => !line.startsWith('export async function'));
      const reexports = text.split('\n').filter((line) => /^export \{/.test(line));
      expect(offending, path).toEqual([]);
      expect(reexports, path).toEqual([]);
    }
  });
});

/**
 * `redirect` reports success by throwing. Keeping it inside the import's try/catch converted every
 * successful import into a knowledge error state.
 */
describe('successful import redirects instead of reporting an error', () => {
  it('lets the redirect signal propagate', async () => {
    importWebsiteKnowledge.mockResolvedValue('20000000-0000-4000-8000-000000000001');

    await expect(
      actions.startKnowledgeImportAction(knowledgeInitialActionState, form('https://clinic.test/')),
    ).rejects.toSatisfy(isRedirect);

    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/ai-front-office/knowledge');
    expect(redirect).toHaveBeenCalledWith(
      '/dashboard/ai-front-office/knowledge/imports/20000000-0000-4000-8000-000000000001',
    );
  });

  it('does not turn the redirect into an action error state', async () => {
    importWebsiteKnowledge.mockResolvedValue('20000000-0000-4000-8000-000000000001');

    const outcome = await actions
      .startKnowledgeImportAction(knowledgeInitialActionState, form('https://clinic.test/'))
      .catch((error: unknown) => (isRedirect(error) ? 'redirected' : error));

    expect(outcome).toBe('redirected');
  });
});

describe('genuine import failures still return a safe error state', () => {
  it('surfaces a knowledge service message without redirecting', async () => {
    importWebsiteKnowledge.mockRejectedValue(
      new KnowledgeServiceError('That website blocks automated crawling.'),
    );
    redirect.mockClear();

    await expect(
      actions.startKnowledgeImportAction(knowledgeInitialActionState, form('https://clinic.test/')),
    ).resolves.toEqual({ message: 'That website blocks automated crawling.', status: 'error' });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('does not leak an internal failure to the operator', async () => {
    importWebsiteKnowledge.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.4:5432'));
    redirect.mockClear();

    const state = await actions.startKnowledgeImportAction(
      knowledgeInitialActionState,
      form('https://clinic.test/'),
    );

    expect(state).toEqual({
      message: 'Knowledge import could not be completed.',
      status: 'error',
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('rejects an unusable URL before any import work starts', async () => {
    importWebsiteKnowledge.mockClear();

    const state = await actions.startKnowledgeImportAction(
      knowledgeInitialActionState,
      form('   '),
    );

    expect(state.status).toBe('error');
    expect(importWebsiteKnowledge).not.toHaveBeenCalled();
  });
});
