export interface EmbeddingProvider {
  readonly dimensions: number;
  readonly id: string;
  readonly model: string;

  embed(input: readonly string[]): Promise<number[][]>;
}

export class EmbeddingConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EmbeddingConfigurationError';
  }
}

export class EmbeddingOperationError extends Error {
  public constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmbeddingOperationError';
  }
}
