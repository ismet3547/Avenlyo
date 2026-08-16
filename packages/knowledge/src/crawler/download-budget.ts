import { CrawlPolicyError } from './types';

/** Tracks the aggregate response-body allowance for one website crawl. */
export class CrawlDownloadBudget {
  private consumedBytes = 0;

  public constructor(private readonly maxBytes: number) {}

  public remainingBytes(): number {
    return Math.max(0, this.maxBytes - this.consumedBytes);
  }

  /**
   * Charges bytes as they are received, rather than after a response has finished downloading.
   * This keeps the crawl's aggregate allowance from being substantially exceeded by one response.
   */
  public consumeBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remainingBytes()) {
      throw new CrawlPolicyError(
        'body_too_large',
        'The website exceeded the total import size limit.',
      );
    }
    this.consumedBytes += bytes;
  }
}
