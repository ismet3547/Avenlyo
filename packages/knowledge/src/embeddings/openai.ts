import OpenAI from 'openai';

import {
  EmbeddingConfigurationError,
  EmbeddingOperationError,
  type EmbeddingProvider,
} from './provider';

export const defaultEmbeddingModel = 'text-embedding-3-small';
export const defaultEmbeddingDimensions = 1_536;

export interface OpenAIEmbeddingProviderOptions {
  readonly apiKey?: string;
  readonly model?: string;
}

/** Server-only embedding provider. It never reads or exposes client-selected models. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  public readonly dimensions = defaultEmbeddingDimensions;
  public readonly id = 'openai';
  public readonly model: string;
  private readonly client: OpenAI;

  public constructor(options: OpenAIEmbeddingProviderOptions = {}) {
    if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
      throw new EmbeddingConfigurationError('Embedding providers can only run on the server.');
    }
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new EmbeddingConfigurationError(
        'OpenAI embeddings are not configured. Set OPENAI_API_KEY to publish or test knowledge.',
      );
    }
    this.model = options.model ?? process.env.OPENAI_EMBEDDING_MODEL ?? defaultEmbeddingModel;
    this.client = new OpenAI({ apiKey, maxRetries: 0, timeout: 15_000 });
  }

  public async embed(input: readonly string[]): Promise<number[][]> {
    if (input.length === 0) return [];
    try {
      const response = await this.client.embeddings.create({
        dimensions: this.dimensions,
        input: [...input],
        model: this.model,
      });
      if (response.data.length !== input.length) {
        throw new EmbeddingOperationError(
          'The embedding provider returned an incomplete result.',
          false,
        );
      }
      const vectors = response.data.map((entry) => entry.embedding);
      if (vectors.some((vector) => vector.length !== this.dimensions)) {
        throw new EmbeddingOperationError(
          `The embedding model must return ${this.dimensions} dimensions.`,
          false,
        );
      }
      return vectors;
    } catch (error) {
      if (error instanceof EmbeddingOperationError) throw error;
      const status =
        error instanceof OpenAI.APIError && typeof error.status === 'number'
          ? error.status
          : undefined;
      const retryable =
        status === 429 || (status !== undefined && status >= 500) || status === undefined;
      throw new EmbeddingOperationError('The embedding provider request failed.', retryable);
    }
  }
}
