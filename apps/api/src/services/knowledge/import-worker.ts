import { randomUUID } from 'node:crypto';

import {
  CrawlPolicyError,
  RenderedWebsiteCrawler,
  WebsiteCrawler,
  shouldAttemptRenderedFallback,
  type CrawlResult,
} from '@avenlyo/knowledge';
import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';

import { classifyDatabaseError } from '../../observability/errors.js';
import type { WorkerObserver } from '../../observability/worker-observer.js';

import {
  PlaywrightRenderedPageSource,
  renderedCapabilityExecutablePath,
} from './playwright-renderer.js';

const IDLE_POLL_MS = 5_000;
const LEASE_SECONDS = 300;
/** Renewed well before the lease expires, so a slow render never loses work it is still doing. */
const LEASE_RENEW_MS = 90_000;

interface KnowledgeWorkerRpc {
  claim_pending_knowledge_import: {
    Args: { target_worker_id: string; target_lease_seconds: number };
    Returns: readonly {
      attempt_count: number;
      claim_token: string;
      import_id: string;
      location_id: string | null;
      organization_id: string;
      root_url: string;
    }[];
  };
  complete_knowledge_import_crawl: {
    Args: {
      crawled_pages: unknown;
      discovered_count: number;
      final_root_url: string;
      skipped_count: number;
      target_claim_token: string;
      target_import_id: string;
      target_strategy: 'rendered' | 'static';
    };
    Returns: number;
  };
  fail_knowledge_import_as_worker: {
    Args: {
      safe_error_code: string;
      safe_error_message: string;
      target_claim_token: string;
      target_failure_kind: 'capability' | 'policy' | 'transient';
      target_import_id: string;
    };
    Returns: string;
  };
  recover_stale_knowledge_imports: { Args: { target_limit: number }; Returns: number };
  renew_knowledge_import_lease: {
    Args: { target_claim_token: string; target_import_id: string; target_lease_seconds: number };
    Returns: boolean;
  };
}

type KnowledgeClient = SupabaseClient<Database> & {
  rpc: <Name extends keyof KnowledgeWorkerRpc>(
    name: Name,
    args: KnowledgeWorkerRpc[Name]['Args'],
  ) => Promise<{
    data: KnowledgeWorkerRpc[Name]['Returns'] | null;
    error: { message: string } | null;
  }>;
};

interface ClaimedImport {
  readonly claimToken: string;
  readonly importId: string;
  readonly rootUrl: string;
}

/**
 * Runs website imports that an authenticated owner or admin already created.
 *
 * Static first, always. A cheap fetch answers most sites, and a browser is launched only when a
 * completed static crawl produced nothing usable — never to retry something policy refused, and
 * never when one usable page already exists.
 *
 * Rendering capability is a deployment property, not a runtime surprise. A host without Chromium
 * still serves every static import; a site that genuinely needs rendering fails with a bounded
 * capability message rather than a crash or an endless retry, because re-running it on the same
 * host would answer the same way.
 */
export class KnowledgeImportWorker {
  private active = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private tickErrorCode: string | null = null;
  private readonly workerId = `knowledge-${randomUUID()}`;

  public constructor(
    private readonly input: {
      readonly observer?: WorkerObserver;
      readonly renderedExecutablePath?: string;
      readonly supabase: SupabaseClient<Database>;
    },
  ) {}

  public start(): void {
    if (this.stopped || this.timer) return;
    this.input.observer?.onStart();
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
    this.input.observer?.onStop();
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.active || this.stopped) return;
    this.active = true;
    this.tickErrorCode = null;
    this.inFlight = this.run();
    try {
      await this.inFlight;
      // A tick that finds no import is a healthy tick: "no work" is not a failure.
      this.input.observer?.onTick(
        this.tickErrorCode ? { errorCode: this.tickErrorCode, ok: false } : { ok: true },
      );
    } catch {
      this.input.observer?.onTick({ errorCode: 'knowledge_worker_failure', ok: false });
    } finally {
      this.inFlight = null;
      this.active = false;
      this.schedule(IDLE_POLL_MS);
    }
  }

  private get client(): KnowledgeClient {
    return this.input.supabase as KnowledgeClient;
  }

  private async run(): Promise<void> {
    let claimed: ClaimedImport | null;
    try {
      // Abandoned work returns to the queue first, so a crashed process cannot strand an import.
      await this.client.rpc('recover_stale_knowledge_imports', { target_limit: 10 });
      const claim = await this.client.rpc('claim_pending_knowledge_import', {
        target_lease_seconds: LEASE_SECONDS,
        target_worker_id: this.workerId,
      });
      if (claim.error) {
        this.tickErrorCode = 'database_unavailable';
        return;
      }
      const row = claim.data?.[0];
      claimed = row
        ? { claimToken: row.claim_token, importId: row.import_id, rootUrl: row.root_url }
        : null;
    } catch (error) {
      // Claiming is a database call; a thrown transport failure here is never a crawl problem.
      this.tickErrorCode = classifyDatabaseError(error);
      return;
    }
    if (!claimed) return;
    await this.execute(claimed);
  }

  private async execute(claimed: ClaimedImport): Promise<void> {
    // Renewal runs for as long as the import does, so a legitimate slow render is never mistaken
    // for a dead worker and recovered out from under itself.
    const renew = setInterval(() => {
      void this.client
        .rpc('renew_knowledge_import_lease', {
          target_claim_token: claimed.claimToken,
          target_import_id: claimed.importId,
          target_lease_seconds: LEASE_SECONDS,
        })
        .catch(() => undefined);
    }, LEASE_RENEW_MS);

    try {
      const { result, strategy } = await this.crawl(claimed.rootUrl);
      await this.client.rpc('complete_knowledge_import_crawl', {
        crawled_pages: result.pages.map((page) => ({
          canonical_url: page.canonicalUrl,
          content: page.content,
          content_hash: page.contentHash,
          title: page.title,
        })),
        discovered_count: result.pagesDiscovered,
        final_root_url: result.rootUrl,
        skipped_count: result.pagesSkipped,
        target_claim_token: claimed.claimToken,
        target_import_id: claimed.importId,
        target_strategy: strategy,
      });
    } catch (error) {
      await this.fail(claimed, error);
    } finally {
      clearInterval(renew);
    }
  }

  /**
   * Static first, rendered only as a last resort.
   *
   * A thrown static crawl never escalates: every `CrawlPolicyError` is a decision — invalid URL,
   * private address, robots refusal, out-of-scope redirect, size or redirect limit — and re-running
   * it in a browser would be using rendering to launder a policy answer.
   */
  private async crawl(
    rootUrl: string,
  ): Promise<{ result: CrawlResult; strategy: 'rendered' | 'static' }> {
    const staticResult = await new WebsiteCrawler().crawl(rootUrl);
    if (!shouldAttemptRenderedFallback(staticResult)) {
      return { result: staticResult, strategy: 'static' };
    }
    if (!renderedCapabilityExecutablePath(this.input.renderedExecutablePath)) {
      throw new CrawlPolicyError(
        'request_failed',
        'This website needs JavaScript rendering, which is not available right now.',
      );
    }
    const source = new PlaywrightRenderedPageSource(
      this.input.renderedExecutablePath
        ? { executablePath: this.input.renderedExecutablePath }
        : {},
    );
    try {
      await source.start();
      const rendered = await new RenderedWebsiteCrawler(source).crawl(rootUrl);
      return { result: rendered, strategy: 'rendered' };
    } finally {
      // The browser and its proxy are torn down on every path, success or failure alike.
      await source.close();
    }
  }

  /**
   * Records why an attempt ended, in terms the database can act on.
   *
   * A policy answer is final; a missing browser is a capability answer and equally final on this
   * host; anything else may be transient and is retried until the attempt budget is spent. Only the
   * bounded message reaches the operator — never a browser error, a stack, or an address.
   */
  private async fail(claimed: ClaimedImport, error: unknown): Promise<void> {
    const policyError = error instanceof CrawlPolicyError ? error : null;
    const isCapability =
      policyError?.message.includes('JavaScript rendering, which is not available') === true;
    const kind = isCapability ? 'capability' : policyError ? 'policy' : 'transient';
    await this.client
      .rpc('fail_knowledge_import_as_worker', {
        safe_error_code: policyError?.code ?? 'import_failed',
        safe_error_message: policyError?.message ?? 'Knowledge import could not be completed.',
        target_claim_token: claimed.claimToken,
        target_failure_kind: kind,
        target_import_id: claimed.importId,
      })
      .catch(() => undefined);
    // A deliberate policy or capability outcome is the worker doing its job, not a worker fault.
    if (kind === 'transient') this.tickErrorCode = 'knowledge_import_failed';
  }
}
