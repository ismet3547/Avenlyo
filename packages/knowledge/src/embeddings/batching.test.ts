import { describe, expect, it, vi } from 'vitest';

import { embedInBatches } from './batching';
import { EmbeddingOperationError, type EmbeddingProvider } from './provider';

const fakeProvider: EmbeddingProvider = {
  dimensions: 3,
  id: 'fake',
  model: 'fake-3',
  embed(input) {
    return Promise.resolve(input.map((_, index) => [index, index + 1, index + 2]));
  },
};

describe('embedding batches', () => {
  it('batches input without partial output', async () => {
    await expect(embedInBatches(fakeProvider, ['a', 'b', 'c'], { batchSize: 2 })).resolves.toEqual([
      [0, 1, 2],
      [1, 2, 3],
      [0, 1, 2],
    ]);
  });

  it('retries transient failures and rejects a dimension mismatch', async () => {
    const provider = { ...fakeProvider, embed: vi.fn() };
    provider.embed
      .mockRejectedValueOnce(new EmbeddingOperationError('temporary', true))
      .mockResolvedValueOnce([[1, 2, 3]]);
    await expect(
      embedInBatches(provider, ['a'], { sleep: () => Promise.resolve() }),
    ).resolves.toEqual([[1, 2, 3]]);
    expect(provider.embed).toHaveBeenCalledTimes(2);
    await expect(
      embedInBatches(
        {
          ...fakeProvider,
          embed: () => Promise.resolve([[1, 2]]),
        },
        ['a'],
      ),
    ).rejects.toThrow('Expected embeddings');
  });
});
