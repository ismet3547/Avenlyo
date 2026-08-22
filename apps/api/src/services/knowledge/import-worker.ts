import { randomUUID } from 'node:crypto';

import {
  CrawlPolicyError,
  RenderCapabilityError,
  RenderedWebsiteCrawler,
  WebsiteCrawler,
  shouldAttemptRenderedFallback,
  type CrawlResult,
  type RenderedPageSource,
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

/**
 * Only `code` is ever read off a database error.
 *
 * PostgREST puts the raw PostgreSQL message, detail, and hint in here; those carry identifiers,
 * row values, and function bodies. The five-character SQLSTATE carries none of that and is the one
 * field that distinguishes "this claim is gone" from "the database is down".
 */
interface KnowledgeRpcError {
  readonly code?: string;
  readonly message: string;
}

type KnowledgeClient = SupabaseClient<Database> & {
  rpc: <Name extends keyof KnowledgeWorkerRpc>(
    name: Name,
    args: KnowledgeWorkerRpc[Name]['Args'],
  ) => Promise<{
    data: KnowledgeWorkerRpc[Name]['Returns'] | null;
    error: KnowledgeRpcError | null;
  }>;
};

/** PostgreSQL `insufficient_privilege`, which is how every worker RPC refuses a dead claim. */
const CLAIM_REJECTED_SQLSTATE = '42501';

/**
 * A worker RPC that did not succeed, reduced to a bounded code before it propagates.
 *
 * Supabase reports two entirely different kinds of failure through one call: a thrown transport
 * error, and a resolved `{ data: null, error }`. Neither is optional to handle, and a resolved
 * `{ error }` is the dangerous one — awaiting the promise succeeds, so an unchecked call reads as
 * a completed write. Every worker RPC goes through `callRpc` so that both shapes end up here.
 */
class KnowledgeRpcFailure extends Error {
  public constructor(
    public readonly rpc: string,
    public readonly errorCode: string,
    /** True when the database refused because this worker no longer holds a live claim. */
    public readonly claimRejected: boolean,
  ) {
    super(`${rpc} did not succeed`);
    this.name = 'KnowledgeRpcFailure';
  }
}

/**
 * Which crawl outcomes are worth another attempt.
 *
 * Everything else a `CrawlPolicyError` reports is a decision about the site — an invalid URL, a
 * private address, an out-of-scope domain, a robots refusal, a redirect or size limit, an
 * unsupported content type — and re-running it would reach the same decision while spending an
 * attempt. These two are the transport ones: a connection that failed and a site that did not
 * answer in time are properties of the moment, not of the site, so they get the bounded retry
 * budget the schema already enforces.
 */
const TRANSIENT_CRAWL_CODES: ReadonlySet<CrawlPolicyError['code']> = new Set([
  'request_failed',
  'request_timeout',
] as const);

export type KnowledgeFailureKind = 'capability' | 'policy' | 'transient';

/**
 * Classifies a crawl failure into what the database should do with the import.
 *
 * `RenderCapabilityError` is matched by type rather than by its message. It subclasses
 * `CrawlPolicyError` with code `request_failed`, so once transport codes became retryable a
 * substring match on the message text was the only thing separating "this host has no browser"
 * from "the site did not answer" — and it would have started retrying a missing browser three
 * times per import the moment anyone reworded the string.
 */
export function classifyCrawlFailure(error: unknown): KnowledgeFailureKind {
  if (error instanceof RenderCapabilityError) return 'capability';
  if (!(error instanceof CrawlPolicyError)) return 'transient';
  return TRANSIENT_CRAWL_CODES.has(error.code) ? 'transient' : 'policy';
}

/**
 * Everything one pass through the worker is willing to say about itself.
 *
 * Bounded on purpose: two flags, one counter, and a code from a fixed set. No URL, no database
 * message, no stack. It exists so a completion that the database refused is observable instead of
 * being inferred from an import that quietly stayed `running` until its lease expired.
 */
export interface KnowledgeWorkerPass {
  /** The database refused a write because this worker no longer holds a live claim. */
  readonly claimLost: boolean;
  /** A crawl was persisted. False whenever completion was attempted and did not land. */
  readonly completed: boolean;
  readonly errorCode: string | null;
  readonly leaseRenewalFailures: number;
}

interface ClaimedImport {
  readonly claimToken: string;
  readonly importId: string;
  readonly rootUrl: string;
}

/** A browser-backed source with the lifecycle the worker owns: start it, use it, always close it. */
export interface ManagedRenderedSource extends RenderedPageSource {
  close(): Promise<void>;
  start(): Promise<void>;
}

export interface KnowledgeImportWorkerInput {
  readonly observer?: WorkerObserver;
  readonly renderedExecutablePath?: string;
  readonly supabase: SupabaseClient<Database>;
  /**
   * Seams, defaulted to the real crawler, the real capability probe, and the real browser.
   *
   * They exist so the escalation *policy* — static first, render only an empty completed crawl,
   * never render a refusal — can be tested without a network or a browser binary. Production passes
   * none of them, so the tested path and the shipped path are the same code.
   */
  readonly capabilityPath?: (explicit?: string) => string | undefined;
  readonly crawlRendered?: (source: RenderedPageSource, rootUrl: string) => Promise<CrawlResult>;
  readonly crawlStatic?: (rootUrl: string) => Promise<CrawlResult>;
  readonly createRenderedSource?: (executablePath: string) => ManagedRenderedSource;
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
  private pass: KnowledgeWorkerPass = emptyPass();
  private readonly workerId = `knowledge-${randomUUID()}`;

  public constructor(private readonly input: KnowledgeImportWorkerInput) {}

  /** What the most recent pass did, in bounded terms. The loop and the tests read the same value. */
  public lastPass(): KnowledgeWorkerPass {
    return this.pass;
  }

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
    this.inFlight = this.pollOnce();
    try {
      await this.inFlight;
      // A tick that finds no import is a healthy tick: "no work" is not a failure. A tick that
      // could not record what it did is not, however much of the crawl succeeded.
      const errorCode = this.pass.errorCode;
      this.input.observer?.onTick(errorCode ? { errorCode, ok: false } : { ok: true });
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

  /**
   * The only way this worker calls the database.
   *
   * Both failure shapes converge on one thrown `KnowledgeRpcFailure`, so no caller can accidentally
   * treat a resolved `{ data: null, error }` as a completed write — which is exactly what awaiting
   * the promise and reading nothing else used to do. Nothing from the database message survives the
   * call: only a bounded code, and the SQLSTATE that says whether the claim itself was refused.
   */
  private async callRpc<Name extends keyof KnowledgeWorkerRpc>(
    name: Name,
    args: KnowledgeWorkerRpc[Name]['Args'],
  ): Promise<KnowledgeWorkerRpc[Name]['Returns'] | null> {
    let response: {
      data: KnowledgeWorkerRpc[Name]['Returns'] | null;
      error: KnowledgeRpcError | null;
    };
    try {
      response = await this.client.rpc(name, args);
    } catch (error) {
      throw new KnowledgeRpcFailure(name, classifyDatabaseError(error), false);
    }
    if (response.error) {
      const claimRejected = response.error.code === CLAIM_REJECTED_SQLSTATE;
      // A refused claim is not an outage. Reporting it as one would page an operator every time
      // recovery legitimately took work away from a worker that overran its lease.
      throw new KnowledgeRpcFailure(
        name,
        claimRejected ? 'knowledge_claim_rejected' : 'database_rejected',
        claimRejected,
      );
    }
    return response.data;
  }

  private note(update: Partial<KnowledgeWorkerPass>): void {
    this.pass = { ...this.pass, ...update };
  }

  /** One claim-and-run pass. Public so the loop can be driven deterministically in a test. */
  public async pollOnce(): Promise<void> {
    this.pass = emptyPass();
    let claimed: ClaimedImport | null;
    try {
      // Abandoned work returns to the queue first, so a crashed process cannot strand an import.
      // A recovery that did not run is not a healthy pass and is not silently stepped over: the two
      // calls share one client and one database, so a recovery the database refused is the first
      // and cheapest evidence that claiming would be running work on a database that is not
      // answering. The pass stops here and says so rather than reporting a clean empty poll.
      await this.callRpc('recover_stale_knowledge_imports', { target_limit: 10 });
      // Exactly one claim per pass, whatever the queue depth. The idle timer, not a loop here, is
      // what decides how fast this worker takes on more work.
      const rows = await this.callRpc('claim_pending_knowledge_import', {
        target_lease_seconds: LEASE_SECONDS,
        target_worker_id: this.workerId,
      });
      const row = rows?.[0];
      claimed = row
        ? { claimToken: row.claim_token, importId: row.import_id, rootUrl: row.root_url }
        : null;
    } catch (error) {
      // Claiming is a database call; a failure here is never a crawl problem, and crawling without
      // a lease would run an import a second worker also holds.
      this.note({ errorCode: rpcErrorCode(error) });
      return;
    }
    if (!claimed) return;
    await this.execute(claimed);
  }

  private async execute(claimed: ClaimedImport): Promise<void> {
    // Renewal runs for as long as the import does, so a legitimate slow render is never mistaken
    // for a dead worker and recovered out from under itself.
    const renew = setInterval(() => void this.renewLease(claimed), LEASE_RENEW_MS);
    try {
      let crawled: { result: CrawlResult; strategy: 'rendered' | 'static' };
      try {
        crawled = await this.crawl(claimed.rootUrl);
      } catch (error) {
        await this.recordFailure(claimed, error);
        return;
      }
      await this.completeCrawl(claimed, crawled.result, crawled.strategy);
    } finally {
      clearInterval(renew);
    }
  }

  /**
   * Extends the lease, and notices when it no longer has one to extend.
   *
   * Runs on a timer, so nothing awaits it and an unhandled rejection here would take the process
   * down. It therefore absorbs its own failures -- but into bounded state, not into nothing. A
   * renewal the database refused, and a renewal that returned `false` because recovery has already
   * taken the import away, are both facts the pass reports.
   *
   * It deliberately does not abort the crawl in flight. The crawl is already bounded by the import
   * deadline, recovery owns the import from the moment the lease lapsed, and completion will be
   * refused by the database rather than by a guess made here.
   */
  private async renewLease(claimed: ClaimedImport): Promise<void> {
    try {
      const renewed = await this.callRpc('renew_knowledge_import_lease', {
        target_claim_token: claimed.claimToken,
        target_import_id: claimed.importId,
        target_lease_seconds: LEASE_SECONDS,
      });
      if (renewed === false) {
        this.note({ claimLost: true, errorCode: 'knowledge_claim_rejected' });
      }
    } catch (error) {
      this.note({
        claimLost: this.pass.claimLost || isClaimRejected(error),
        errorCode: rpcErrorCode(error),
        leaseRenewalFailures: this.pass.leaseRenewalFailures + 1,
      });
    }
  }

  /**
   * Persists the crawl, and treats a completion the database did not accept as exactly that.
   *
   * A completion failure is never routed into `fail_knowledge_import_as_worker`. Two reasons, and
   * they point the same way. If the claim was refused, recovery already owns the import and this
   * worker has no standing to record anything about it. If the database is simply unavailable, the
   * crawl itself was fine -- spending one of three attempts on a failure that says nothing about
   * the site, using the same database that just failed, would turn an outage into abandoned
   * imports. Leaving the lease to lapse returns the import to `pending` through recovery, which is
   * the path built for this. What must not happen -- and did -- is the pass reporting success.
   */
  private async completeCrawl(
    claimed: ClaimedImport,
    result: CrawlResult,
    strategy: 'rendered' | 'static',
  ): Promise<void> {
    try {
      await this.callRpc('complete_knowledge_import_crawl', {
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
      this.note({ completed: true });
    } catch (error) {
      this.note({
        claimLost: this.pass.claimLost || isClaimRejected(error),
        completed: false,
        errorCode: rpcErrorCode(error),
      });
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
    const crawlStatic =
      this.input.crawlStatic ?? ((target: string) => new WebsiteCrawler().crawl(target));
    const staticResult = await crawlStatic(rootUrl);
    if (!shouldAttemptRenderedFallback(staticResult)) {
      return { result: staticResult, strategy: 'static' };
    }
    const capabilityPath = this.input.capabilityPath ?? renderedCapabilityExecutablePath;
    const executablePath = capabilityPath(this.input.renderedExecutablePath);
    // The typed capability error, not a hand-built `CrawlPolicyError` carrying the same words.
    // Its code is `request_failed`, which is now retryable, so the type is the only thing that
    // keeps a host with no browser from being attempted three times per import.
    if (!executablePath) throw new RenderCapabilityError();
    const createSource =
      this.input.createRenderedSource ??
      ((path: string) => new PlaywrightRenderedPageSource({ executablePath: path }));
    const crawlRendered =
      this.input.crawlRendered ??
      ((target: RenderedPageSource, url: string) => new RenderedWebsiteCrawler(target).crawl(url));
    const source = createSource(executablePath);
    try {
      await source.start();
      const rendered = await crawlRendered(source, rootUrl);
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
   * host; a transport failure may be transient and is retried until the attempt budget is spent.
   * Only the bounded message reaches the operator — never a browser error, a stack, or an address.
   *
   * The recording call can itself fail, and it must not take the process with it: this runs on the
   * failure path, where throwing again would lose the original outcome too. So it is caught — and
   * then reported, because a failure nobody could write down is a worse operational state than the
   * failure itself, not a quieter one.
   */
  private async recordFailure(claimed: ClaimedImport, error: unknown): Promise<void> {
    const policyError = error instanceof CrawlPolicyError ? error : null;
    const kind = classifyCrawlFailure(error);
    // A deliberate policy or capability outcome is the worker doing its job, not a worker fault.
    if (kind === 'transient') this.note({ errorCode: 'knowledge_import_failed' });
    try {
      await this.callRpc('fail_knowledge_import_as_worker', {
        safe_error_code: policyError?.code ?? 'import_failed',
        safe_error_message: policyError?.message ?? 'Knowledge import could not be completed.',
        target_claim_token: claimed.claimToken,
        target_failure_kind: kind,
        target_import_id: claimed.importId,
      });
    } catch (rpcError) {
      this.note({
        claimLost: this.pass.claimLost || isClaimRejected(rpcError),
        errorCode: rpcErrorCode(rpcError),
      });
    }
  }
}

function emptyPass(): KnowledgeWorkerPass {
  return { claimLost: false, completed: false, errorCode: null, leaseRenewalFailures: 0 };
}

/** Anything thrown outside `callRpc` is an unexpected worker fault, not a database verdict. */
function rpcErrorCode(error: unknown): string {
  return error instanceof KnowledgeRpcFailure ? error.errorCode : 'knowledge_worker_failure';
}

function isClaimRejected(error: unknown): boolean {
  return error instanceof KnowledgeRpcFailure && error.claimRejected;
}
