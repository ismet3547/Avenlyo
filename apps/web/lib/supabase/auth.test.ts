import type { User } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvenlyoSupabaseClient } from './server';

/**
 * `resolveAuthContext` is the uncached core of `getRequiredAuthContext`. It is tested directly,
 * not through the `cache()`-wrapped export, because React's per-request cache dispatcher only
 * memoizes inside an active Server Component render and is a silent no-op anywhere else -- a plain
 * Vitest run would either always show two calls (no memoization to observe) or falsely appear to
 * dedupe for reasons that have nothing to do with the real request-scoped mechanism.
 */

vi.mock('./server', () => ({
  createServerSupabaseClient: vi.fn(),
}));

const { createServerSupabaseClient } = await import('./server');
const { resolveAuthContext } = await import('./auth');

function fakeUser(id: string): User {
  return { id } as unknown as User;
}

function fakeClient(
  user: User | null,
  error: { message: string } | null = null,
): { client: AvenlyoSupabaseClient; getUser: ReturnType<typeof vi.fn> } {
  const getUser = vi.fn(() => Promise.resolve({ data: { user }, error }));
  const client = { auth: { getUser } } as unknown as AvenlyoSupabaseClient;
  return { client, getUser };
}

beforeEach(() => {
  vi.mocked(createServerSupabaseClient).mockReset();
});

describe('resolveAuthContext', () => {
  it('returns null when Supabase is not configured', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(null);
    await expect(resolveAuthContext()).resolves.toBeNull();
  });

  it('returns null when the session is invalid or expired', async () => {
    const { client } = fakeClient(null, { message: 'invalid session' });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    await expect(resolveAuthContext()).resolves.toBeNull();
  });

  it('returns null when there is no error but also no user', async () => {
    const { client } = fakeClient(null);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    await expect(resolveAuthContext()).resolves.toBeNull();
  });

  it('returns the trusted user together with the exact client instance it was verified against', async () => {
    const user = fakeUser('user-1');
    const { client } = fakeClient(user);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const context = await resolveAuthContext();

    expect(context?.user).toBe(user);
    expect(context?.supabase).toBe(client);
  });

  it('always re-verifies against Supabase Auth -- it never returns a user without calling getUser', async () => {
    const { client, getUser } = fakeClient(fakeUser('user-1'));
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await resolveAuthContext();
    await resolveAuthContext();

    // Uncached, so two calls to the resolver mean two real round trips. Request-scoped memoization
    // is layered on top by `cache()` in `getRequiredAuthContext`, not by this function.
    expect(getUser).toHaveBeenCalledTimes(2);
  });
});
