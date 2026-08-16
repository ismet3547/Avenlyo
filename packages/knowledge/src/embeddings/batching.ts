import { EmbeddingOperationError, type EmbeddingProvider } from './provider';

export interface EmbeddingBatchOptions {
  readonly batchSize?: number;
  readonly maxRetries?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function assertDimensions(vectors: readonly number[][], dimensions: number): void {
  if (vectors.some((vector) => vector.length !== dimensions)) {
    throw new EmbeddingOperationError(`Expected embeddings with ${dimensions} dimensions.`, false);
  }
}

export async function embedInBatches(
  provider: EmbeddingProvider,
  input: readonly string[],
  options: EmbeddingBatchOptions = {},
): Promise<number[][]> {
  const batchSize = options.batchSize ?? 32;
  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? pause;
  const output: number[][] = [];

  for (let start = 0; start < input.length; start += batchSize) {
    const batch = input.slice(start, start + batchSize);
    let attempt = 0;
    while (true) {
      try {
        const vectors = await provider.embed(batch);
        if (vectors.length !== batch.length) {
          throw new EmbeddingOperationError(
            'The embedding provider returned an incomplete batch.',
            false,
          );
        }
        assertDimensions(vectors, provider.dimensions);
        output.push(...vectors);
        break;
      } catch (error) {
        const retryable = error instanceof EmbeddingOperationError ? error.retryable : true;
        if (!retryable || attempt >= maxRetries) throw error;
        const jitter = Math.floor(Math.random() * 100);
        await sleep(250 * 2 ** attempt + jitter);
        attempt += 1;
      }
    }
  }

  return output;
}
