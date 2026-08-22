import { describe, expect, it, vi } from 'vitest';

import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

import { resolveHandoffQueueSummary } from './service';

/**
 * `resolveHandoffQueueSummary` is the uncached core of `loadHandoffQueueSummary`, tested the same
 * way `resolveAuthContext` is: directly, because `cache()` only memoizes inside an active Server
 * Component render and is a no-op in a plain Vitest run.
 */

type RpcResult = { data: unknown; error: { message: string } | null };

function clientWith(result: RpcResult) {
  const rpc = vi.fn(() => Promise.resolve(result));
  return { client: { rpc } as unknown as AvenlyoSupabaseClient, rpc };
}

describe('resolveHandoffQueueSummary', () => {
  it('reads the summary for the given location', async () => {
    const row = { assigned_to_me: 1, needs_attention: 4, urgent: 2 };
    const { client, rpc } = clientWith({ data: [row], error: null });

    await expect(resolveHandoffQueueSummary(client, 'location-1')).resolves.toEqual(row);
    expect(rpc).toHaveBeenCalledWith('get_my_handoff_queue_summary', {
      target_location_id: 'location-1',
    });
  });

  it('accepts a caller with no location assigned', async () => {
    const row = { assigned_to_me: 0, needs_attention: 0, urgent: 0 };
    const { client, rpc } = clientWith({ data: [row], error: null });

    await resolveHandoffQueueSummary(client, null);
    expect(rpc).toHaveBeenCalledWith('get_my_handoff_queue_summary', { target_location_id: null });
  });

  it('fails closed to null rather than throwing, so a summary read can never take the dashboard down', async () => {
    const { client } = clientWith({ data: null, error: { message: 'permission denied' } });
    await expect(resolveHandoffQueueSummary(client, 'location-1')).resolves.toBeNull();
  });

  it('returns null when the RPC reports success but no row', async () => {
    const { client } = clientWith({ data: [], error: null });
    await expect(resolveHandoffQueueSummary(client, 'location-1')).resolves.toBeNull();
  });
});
