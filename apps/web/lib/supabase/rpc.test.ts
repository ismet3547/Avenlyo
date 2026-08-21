import { describe, expect, it } from 'vitest';

import { createRpcGuards } from './rpc';

class TestError extends Error {
  public constructor() {
    super('guard rejected');
    this.name = 'TestError';
  }
}

const { requireRpcData, requireVoidRpc } = createRpcGuards(() => new TestError());

/**
 * The distinction these guards exist for: PostgREST answers a `returns void` function with
 * `data: null, error: null`, which is a success. Collapsing that into "null data means failure"
 * made the product report errors for work the database had already committed.
 */
describe('void RPC guard', () => {
  it('accepts the success shape of a returns-void function', async () => {
    await expect(
      requireVoidRpc(Promise.resolve({ data: null, error: null })),
    ).resolves.toBeUndefined();
  });

  it('still fails closed on a database error', async () => {
    await expect(
      requireVoidRpc(Promise.resolve({ data: null, error: { message: 'permission denied' } })),
    ).rejects.toBeInstanceOf(TestError);
  });

  it('does not leak the database message into the thrown error', async () => {
    await expect(
      requireVoidRpc(
        Promise.resolve({
          data: null,
          error: { message: 'relation "secret_table" does not exist' },
        }),
      ),
    ).rejects.toThrow(/^guard rejected$/);
  });
});

describe('data RPC guard', () => {
  it('returns the rows a data-returning function produced', async () => {
    await expect(
      requireRpcData(Promise.resolve({ data: [{ id: 'a' }], error: null })),
    ).resolves.toEqual([{ id: 'a' }]);
  });

  it('accepts a scalar result, including a falsy one', async () => {
    // `save_knowledge_import_pages` and `complete_knowledge_publish` return an integer, and zero is
    // a real answer that must not be mistaken for a missing one.
    await expect(requireRpcData(Promise.resolve({ data: 0, error: null }))).resolves.toBe(0);
  });

  it('still rejects unexpected null data', async () => {
    // The null check is narrowed, never weakened: a function contractually required to return rows
    // and returning none is still a failure.
    await expect(
      requireRpcData(Promise.resolve({ data: null, error: null })),
    ).rejects.toBeInstanceOf(TestError);
  });

  it('still fails closed on a database error even with data present', async () => {
    await expect(
      requireRpcData(Promise.resolve({ data: [{ id: 'a' }], error: { message: 'conflict' } })),
    ).rejects.toBeInstanceOf(TestError);
  });
});

describe('guard identity', () => {
  it('throws the error its own service supplied', async () => {
    class OtherError extends Error {}
    const other = createRpcGuards(() => new OtherError());
    await expect(
      other.requireVoidRpc(Promise.resolve({ data: null, error: { message: 'x' } })),
    ).rejects.toBeInstanceOf(OtherError);
    await expect(
      requireVoidRpc(Promise.resolve({ data: null, error: { message: 'x' } })),
    ).rejects.not.toBeInstanceOf(OtherError);
  });
});
