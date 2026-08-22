import {
  CrawlPolicyError,
  RenderCapabilityError,
  type CrawlResult,
  type RenderedPage,
} from '@avenlyo/knowledge';
import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  KnowledgeImportWorker,
  classifyCrawlFailure,
  type ManagedRenderedSource,
} from './import-worker.js';

/**
 * These drive the escalation policy and the durable claim protocol, with no network, no browser,
 * and no database. What is being tested is the worker's judgement: when a browser is worth
 * launching, when it is not, and what the database is told afterwards.
 *
 * The seams are the real ones production uses; only their implementations are fakes. A test that
 * reimplemented the decision itself would pass no matter what the worker did.
 */

interface RpcCall {
  readonly args: Record<string, unknown>;
  readonly name: string;
}

function crawlResult(input: { readonly pages: number; readonly rootUrl?: string }): CrawlResult {
  return {
    pages: Array.from({ length: input.pages }, (_unused, index) => ({
      canonicalUrl: `https://clinic.test/page-${index}`,
      content: `Wellness visits and vaccinations, page ${index}.`,
      contentHash: `hash-${index}`,
      title: `Page ${index}`,
    })),
    pagesDiscovered: input.pages,
    pagesSkipped: 0,
    rootUrl: input.rootUrl ?? 'https://clinic.test/',
  };
}

/** A static crawl that does not finish until the test says so. */
function gatedCrawl(pages = 1) {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    crawlStatic: async () => {
      await opened;
      return crawlResult({ pages });
    },
    release: () => release(),
  };
}

/**
 * What one RPC does when the worker calls it.
 *
 * `error` is the shape that matters most here. Supabase resolves rather than rejects on a database
 * error, so a call that returns `{ data: null, error }` looks exactly like a completed write to any
 * caller that only awaits it -- which is the defect these tests exist to hold closed.
 */
interface RpcOutcome {
  readonly data?: unknown;
  readonly error?: { readonly code?: string; readonly message: string };
  readonly throws?: Error;
}

const CLAIM_ROW = {
  attempt_count: 1,
  claim_token: 'token-1',
  import_id: 'import-1',
  location_id: null,
  organization_id: 'org-1',
  root_url: 'https://clinic.test/',
} as const;

function fakeSupabase(
  input: {
    readonly claim?: readonly Record<string, unknown>[];
    readonly claimError?: { code?: string; message: string };
    readonly claimThrows?: Error;
    readonly outcomes?: Readonly<Record<string, RpcOutcome>>;
  } = {},
) {
  const calls: RpcCall[] = [];
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    calls.push({ args, name });
    const outcome = input.outcomes?.[name];
    if (outcome) {
      if (outcome.throws) return Promise.reject(outcome.throws);
      if (outcome.error) return Promise.resolve({ data: null, error: outcome.error });
      return Promise.resolve({ data: outcome.data ?? null, error: null });
    }
    if (name === 'claim_pending_knowledge_import') {
      if (input.claimThrows) return Promise.reject(input.claimThrows);
      if (input.claimError) return Promise.resolve({ data: null, error: input.claimError });
      return Promise.resolve({ data: input.claim ?? [CLAIM_ROW], error: null });
    }
    if (name === 'renew_knowledge_import_lease') {
      return Promise.resolve({ data: true, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
  const supabase = { rpc } as unknown as SupabaseClient<Database>;
  return {
    calls,
    callsTo: (name: string) => calls.filter((call) => call.name === name),
    rpc,
    supabase,
  };
}

/**
 * Runs exactly one scheduled tick, so the observer sees what the loop would report.
 *
 * `start()` schedules the first tick on a zero-delay timer and `stop()` cancels a timer that has
 * not fired, so starting and immediately stopping observes nothing. Fake timers make the first
 * tick land deterministically instead of racing a real one.
 */
async function runOneTick(worker: KnowledgeImportWorker): Promise<void> {
  vi.useFakeTimers();
  try {
    worker.start();
    await vi.advanceTimersByTimeAsync(1);
    await worker.stop();
  } finally {
    vi.useRealTimers();
  }
}

/**
 * Runs one pass while holding the crawl open long enough for the lease timer to fire.
 *
 * Renewal is on a 90-second interval that nothing awaits, so it is unreachable from a test that
 * simply awaits `pollOnce()`. Fake timers plus a gate the test releases make the interval land in
 * the middle of a crawl, which is the only place it ever runs in production.
 */
async function passWithLeaseRenewal(
  worker: KnowledgeImportWorker,
  release: () => void,
): Promise<void> {
  const pass = worker.pollOnce();
  await vi.advanceTimersByTimeAsync(95_000);
  release();
  await pass;
}

function fakeRenderedSource(html = '<html><body><main>Rendered clinic text.</main></body></html>') {
  const events: string[] = [];
  const source: ManagedRenderedSource = {
    close: () => Promise.resolve(void events.push('close')),
    render: (url): Promise<RenderedPage> => {
      events.push('render');
      return Promise.resolve({ html, url: url.toString() });
    },
    start: () => Promise.resolve(void events.push('start')),
  };
  return { events, source };
}

describe('static-first escalation', () => {
  it('never launches a browser when the static crawl produced usable pages', async () => {
    const db = fakeSupabase();
    const createRenderedSource = vi.fn(() => fakeRenderedSource().source);
    const worker = new KnowledgeImportWorker({
      capabilityPath: () => '/usr/bin/chromium',
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 3 })),
      createRenderedSource,
      supabase: db.supabase,
    });

    await worker.pollOnce();

    expect(createRenderedSource).not.toHaveBeenCalled();
    const [completed] = db.callsTo('complete_knowledge_import_crawl');
    expect(completed?.args['target_strategy']).toBe('static');
    expect(completed?.args['target_claim_token']).toBe('token-1');
  });

  it('falls back to a browser only when a completed static crawl found nothing', async () => {
    // A site whose text exists only after its JavaScript runs: the static crawl succeeds and
    // returns zero pages, which is the one condition rendering is for.
    const db = fakeSupabase();
    const rendered = fakeRenderedSource();
    const worker = new KnowledgeImportWorker({
      capabilityPath: () => '/usr/bin/chromium',
      crawlRendered: () => Promise.resolve(crawlResult({ pages: 2 })),
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 0 })),
      createRenderedSource: () => rendered.source,
      supabase: db.supabase,
    });

    await worker.pollOnce();

    expect(rendered.events).toEqual(['start', 'close']);
    const [completed] = db.callsTo('complete_knowledge_import_crawl');
    expect(completed?.args['target_strategy']).toBe('rendered');
    expect(db.callsTo('fail_knowledge_import_as_worker')).toHaveLength(0);
  });

  it('does not use rendering to launder a policy refusal', async () => {
    // robots.txt refused the root. Re-running that in a browser would be using the renderer to
    // get an answer the site already declined to give.
    const db = fakeSupabase();
    const createRenderedSource = vi.fn(() => fakeRenderedSource().source);
    const worker = new KnowledgeImportWorker({
      capabilityPath: () => '/usr/bin/chromium',
      crawlStatic: () =>
        Promise.reject(new CrawlPolicyError('robots_disallowed', 'This website disallows import.')),
      createRenderedSource,
      supabase: db.supabase,
    });

    await worker.pollOnce();

    expect(createRenderedSource).not.toHaveBeenCalled();
    const [failed] = db.callsTo('fail_knowledge_import_as_worker');
    expect(failed?.args['target_failure_kind']).toBe('policy');
    expect(failed?.args['safe_error_code']).toBe('robots_disallowed');
  });

  it('closes the browser when the rendered crawl throws', async () => {
    const db = fakeSupabase();
    const rendered = fakeRenderedSource();
    const worker = new KnowledgeImportWorker({
      capabilityPath: () => '/usr/bin/chromium',
      crawlRendered: () => Promise.reject(new Error('renderer crashed')),
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 0 })),
      createRenderedSource: () => rendered.source,
      supabase: db.supabase,
    });

    await worker.pollOnce();

    // A leaked browser process outlives the import and eventually the host.
    expect(rendered.events).toContain('close');
    expect(db.callsTo('fail_knowledge_import_as_worker')[0]?.args['target_failure_kind']).toBe(
      'transient',
    );
  });
});

describe('rendering capability', () => {
  it('answers a host without a browser deterministically instead of retrying forever', async () => {
    const db = fakeSupabase();
    const worker = new KnowledgeImportWorker({
      capabilityPath: () => undefined,
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 0 })),
      supabase: db.supabase,
    });

    await worker.pollOnce();

    const [failed] = db.callsTo('fail_knowledge_import_as_worker');
    // A capability answer is final on this host: another attempt would reach the same conclusion.
    expect(failed?.args['target_failure_kind']).toBe('capability');
    expect(failed?.args['safe_error_message']).toBe(
      'This website needs JavaScript rendering, which is not available right now.',
    );
  });
});

describe('durable claim protocol', () => {
  it('returns abandoned work to the queue before claiming its own', async () => {
    const db = fakeSupabase({ claim: [] });
    const worker = new KnowledgeImportWorker({
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 1 })),
      supabase: db.supabase,
    });

    await worker.pollOnce();

    expect(db.calls.map((call) => call.name)).toEqual([
      'recover_stale_knowledge_imports',
      'claim_pending_knowledge_import',
    ]);
  });

  it('does no work and reports a healthy tick when the queue is empty', async () => {
    const db = fakeSupabase({ claim: [] });
    const crawlStatic = vi.fn(() => Promise.resolve(crawlResult({ pages: 1 })));
    const onTick = vi.fn();
    const worker = new KnowledgeImportWorker({
      crawlStatic,
      observer: { onStart: vi.fn(), onStop: vi.fn(), onTick },
      supabase: db.supabase,
    });

    await worker.pollOnce();

    expect(crawlStatic).not.toHaveBeenCalled();
    expect(db.callsTo('complete_knowledge_import_crawl')).toHaveLength(0);
  });

  it('never crawls when the claim itself failed', async () => {
    const db = fakeSupabase({ claimError: { message: 'connection refused' } });
    const crawlStatic = vi.fn(() => Promise.resolve(crawlResult({ pages: 1 })));
    const worker = new KnowledgeImportWorker({ crawlStatic, supabase: db.supabase });

    await worker.pollOnce();

    // Crawling without a lease would run an import a second worker also holds.
    expect(crawlStatic).not.toHaveBeenCalled();
  });

  it('survives a thrown claim without terminating the loop', async () => {
    const db = fakeSupabase({ claimThrows: new Error('fetch failed') });
    const worker = new KnowledgeImportWorker({
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 1 })),
      supabase: db.supabase,
    });

    await expect(worker.pollOnce()).resolves.toBeUndefined();
  });

  it('carries the claim token into every write it makes', async () => {
    const db = fakeSupabase();
    const worker = new KnowledgeImportWorker({
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 1 })),
      supabase: db.supabase,
    });

    await worker.pollOnce();

    // The token is what proves this worker still owns the import; a write without it must not
    // be able to land, so the worker never omits it.
    for (const call of db.calls.filter((entry) => entry.name.includes('knowledge_import'))) {
      if (call.name === 'recover_stale_knowledge_imports') continue;
      if (call.name === 'claim_pending_knowledge_import') continue;
      expect(call.args['target_claim_token']).toBe('token-1');
    }
  });

  it('sends only bounded page fields to the database', async () => {
    const db = fakeSupabase();
    const worker = new KnowledgeImportWorker({
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 1 })),
      supabase: db.supabase,
    });

    await worker.pollOnce();

    const [completed] = db.callsTo('complete_knowledge_import_crawl');
    const pages = completed?.args['crawled_pages'] as readonly Record<string, unknown>[];
    // Never the organization or location: the database derives tenancy from the import row itself,
    // so worker input can never redirect a document into another tenant.
    expect(Object.keys(pages[0] ?? {}).sort()).toEqual([
      'canonical_url',
      'content',
      'content_hash',
      'title',
    ]);
  });
});

describe('worker lifecycle', () => {
  it('stops cleanly without leaving a timer behind', async () => {
    const db = fakeSupabase({ claim: [] });
    const observer = { onStart: vi.fn(), onStop: vi.fn(), onTick: vi.fn() };
    const worker = new KnowledgeImportWorker({
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 1 })),
      observer,
      supabase: db.supabase,
    });

    worker.start();
    await worker.stop();

    expect(observer.onStart).toHaveBeenCalledTimes(1);
    expect(observer.onStop).toHaveBeenCalledTimes(1);
    // A stopped worker stays stopped, so a late start cannot resurrect the loop after shutdown.
    worker.start();
    expect(observer.onStart).toHaveBeenCalledTimes(1);
  });
});

describe('database results are never assumed', () => {
  it('does not report a completion the database refused as a successful pass', async () => {
    // The load-bearing case. `complete_knowledge_import_crawl` resolves with `{ data: null, error }`
    // rather than throwing, so the previous worker awaited it, cleared its execution path, and
    // reported a healthy tick for an import that was never written.
    const db = fakeSupabase({
      outcomes: { complete_knowledge_import_crawl: { error: { message: 'deadlock detected' } } },
    });
    const onTick = vi.fn();
    const worker = new KnowledgeImportWorker({
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 2 })),
      observer: { onStart: vi.fn(), onStop: vi.fn(), onTick },
      supabase: db.supabase,
    });

    await runOneTick(worker);

    expect(db.callsTo('complete_knowledge_import_crawl')).toHaveLength(1);
    expect(worker.lastPass().completed).toBe(false);
    expect(worker.lastPass().errorCode).toBe('database_rejected');
    expect(onTick).toHaveBeenCalledWith({ errorCode: 'database_rejected', ok: false });
  });

  it('never leaks the database message into the code it reports', async () => {
    const db = fakeSupabase({
      outcomes: {
        complete_knowledge_import_crawl: {
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint on knowledge_documents (import_id)',
          },
        },
      },
    });
    const worker = new KnowledgeImportWorker({
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 1 })),
      supabase: db.supabase,
    });

    await worker.pollOnce();

    // A bounded code and nothing else: constraint names, row values, and SQL text stay in the
    // database, where an operator can look at them with the right authorization.
    expect(worker.lastPass().errorCode).toBe('database_rejected');
    expect(JSON.stringify(worker.lastPass())).not.toContain('knowledge_documents');
  });

  it('treats a refused claim as a lost claim rather than an outage', async () => {
    // 42501 is how every worker RPC says the lease is gone. Recovery taking work from a worker
    // that overran its lease is the system behaving correctly, and must not read as a database
    // failure -- nor must the worker then try to record a failure it has no standing to record.
    const db = fakeSupabase({
      outcomes: {
        complete_knowledge_import_crawl: {
          error: { code: '42501', message: 'Knowledge import claim is no longer valid' },
        },
      },
    });
    const worker = new KnowledgeImportWorker({
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 1 })),
      supabase: db.supabase,
    });

    await worker.pollOnce();

    expect(worker.lastPass()).toMatchObject({
      claimLost: true,
      completed: false,
      errorCode: 'knowledge_claim_rejected',
    });
    // Recovery owns the import now. Writing a failure row would spend an attempt on work this
    // worker no longer holds, and the database would refuse it anyway.
    expect(db.callsTo('fail_knowledge_import_as_worker')).toHaveLength(0);
  });

  it('does not spend an attempt on a completion that failed for database reasons', async () => {
    // The crawl was fine; the database was not. Recording a failure would burn one of three
    // attempts on something that says nothing about the site, using the database that just failed.
    // The lease lapses instead and recovery returns the import to the queue.
    const db = fakeSupabase({
      outcomes: {
        complete_knowledge_import_crawl: { throws: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) },
      },
    });
    const worker = new KnowledgeImportWorker({
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 1 })),
      supabase: db.supabase,
    });

    await worker.pollOnce();

    expect(db.callsTo('fail_knowledge_import_as_worker')).toHaveLength(0);
    expect(worker.lastPass()).toMatchObject({
      completed: false,
      errorCode: 'database_unavailable',
    });
  });

  it('does not let a failed recovery pass for a healthy empty poll', async () => {
    const db = fakeSupabase({
      outcomes: { recover_stale_knowledge_imports: { error: { message: 'timeout' } } },
    });
    const crawlStatic = vi.fn(() => Promise.resolve(crawlResult({ pages: 1 })));
    const onTick = vi.fn();
    const worker = new KnowledgeImportWorker({
      crawlStatic,
      observer: { onStart: vi.fn(), onStop: vi.fn(), onTick },
      supabase: db.supabase,
    });

    await runOneTick(worker);

    // Recovery and claiming share one client and one database. A recovery the database refused is
    // the cheapest possible evidence that claiming would be building on an answer nobody gave.
    expect(db.callsTo('claim_pending_knowledge_import')).toHaveLength(0);
    expect(crawlStatic).not.toHaveBeenCalled();
    expect(onTick).toHaveBeenCalledWith({ errorCode: 'database_rejected', ok: false });
  });

  it('survives a thrown recovery and classifies it as a database failure', async () => {
    const db = fakeSupabase({
      outcomes: {
        recover_stale_knowledge_imports: {
          throws: Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }),
        },
      },
    });
    const worker = new KnowledgeImportWorker({
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 1 })),
      supabase: db.supabase,
    });

    await expect(worker.pollOnce()).resolves.toBeUndefined();
    expect(worker.lastPass().errorCode).toBe('database_unavailable');
  });

  it('claims at most one import per pass however deep the queue is', async () => {
    const db = fakeSupabase({ claim: [CLAIM_ROW, { ...CLAIM_ROW, import_id: 'import-2' }] });
    const worker = new KnowledgeImportWorker({
      crawlStatic: () => Promise.resolve(crawlResult({ pages: 1 })),
      supabase: db.supabase,
    });

    await worker.pollOnce();

    // The idle timer decides how fast this worker takes on work, not a loop inside one pass: a
    // pass that drained the queue would hold every lease it claimed behind one slow render.
    expect(db.callsTo('claim_pending_knowledge_import')).toHaveLength(1);
    expect(db.callsTo('complete_knowledge_import_crawl')).toHaveLength(1);
    expect(db.callsTo('complete_knowledge_import_crawl')[0]?.args['target_import_id']).toBe(
      'import-1',
    );
  });

  it('reports a failure it could not even record, without crashing the pass', async () => {
    const db = fakeSupabase({
      outcomes: { fail_knowledge_import_as_worker: { error: { message: 'connection reset' } } },
    });
    const worker = new KnowledgeImportWorker({
      capabilityPath: () => '/usr/bin/chromium',
      crawlStatic: () =>
        Promise.reject(new CrawlPolicyError('robots_disallowed', 'This website disallows import.')),
      supabase: db.supabase,
    });

    // Throwing again on the failure path would lose the original outcome too, so it is caught --
    // and then reported, because a failure nobody could write down is the worse state.
    await expect(worker.pollOnce()).resolves.toBeUndefined();
    expect(db.callsTo('fail_knowledge_import_as_worker')).toHaveLength(1);
    expect(worker.lastPass().errorCode).toBe('database_rejected');
  });
});

describe('lease renewal', () => {
  it('observes a renewal the database refused without taking the process down', async () => {
    vi.useFakeTimers();
    try {
      const db = fakeSupabase({
        outcomes: { renew_knowledge_import_lease: { error: { message: 'server closed' } } },
      });
      const gate = gatedCrawl();
      const worker = new KnowledgeImportWorker({
        crawlStatic: gate.crawlStatic,
        supabase: db.supabase,
      });

      await passWithLeaseRenewal(worker, gate.release);

      expect(db.callsTo('renew_knowledge_import_lease').length).toBeGreaterThan(0);
      expect(worker.lastPass().leaseRenewalFailures).toBeGreaterThan(0);
      expect(worker.lastPass().errorCode).toBe('database_rejected');
      // The crawl itself was not abandoned: it is already bounded by the import deadline, and
      // recovery -- not a guess made on a timer -- decides who owns the import from here.
      expect(worker.lastPass().completed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('notices when renewal reports the claim is already gone', async () => {
    vi.useFakeTimers();
    try {
      const db = fakeSupabase({
        outcomes: { renew_knowledge_import_lease: { data: false } },
      });
      const gate = gatedCrawl();
      const worker = new KnowledgeImportWorker({
        crawlStatic: gate.crawlStatic,
        supabase: db.supabase,
      });

      await passWithLeaseRenewal(worker, gate.release);

      // `false` is the database saying no live claim matched. That is a lost import, not a slow
      // one, and it must not read as a renewal that quietly worked.
      expect(worker.lastPass()).toMatchObject({
        claimLost: true,
        errorCode: 'knowledge_claim_rejected',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews with the claim token and stops the timer when the pass ends', async () => {
    vi.useFakeTimers();
    try {
      const db = fakeSupabase();
      const gate = gatedCrawl();
      const worker = new KnowledgeImportWorker({
        crawlStatic: gate.crawlStatic,
        supabase: db.supabase,
      });

      await passWithLeaseRenewal(worker, gate.release);
      const duringPass = db.callsTo('renew_knowledge_import_lease').length;
      expect(duringPass).toBeGreaterThan(0);
      expect(db.callsTo('renew_knowledge_import_lease')[0]?.args['target_claim_token']).toBe(
        'token-1',
      );

      // A renewal firing after the import finished would extend a lease on work this worker has
      // already released.
      await vi.advanceTimersByTimeAsync(400_000);
      expect(db.callsTo('renew_knowledge_import_lease')).toHaveLength(duringPass);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('failure classification', () => {
  // The whole table, in one place, because the split is the decision: a structural answer about
  // the site is final, and a transport answer about the moment is worth the bounded retry budget.
  const structural = [
    'body_too_large',
    'dns_private_address',
    'domain_out_of_scope',
    'invalid_content_type',
    'invalid_url',
    'redirect_limit',
    'robots_disallowed',
  ] as const;

  for (const code of structural) {
    it(`treats ${code} as a terminal policy answer`, () => {
      expect(classifyCrawlFailure(new CrawlPolicyError(code, 'refused'))).toBe('policy');
    });
  }

  for (const code of ['request_failed', 'request_timeout'] as const) {
    it(`treats ${code} as transient`, () => {
      expect(classifyCrawlFailure(new CrawlPolicyError(code, 'no answer'))).toBe('transient');
    });
  }

  it('treats a missing renderer as a capability answer by type, not by message text', () => {
    const capability = new RenderCapabilityError();
    // It subclasses CrawlPolicyError with code `request_failed`, which is now retryable. Only the
    // type separates "this host has no browser" from "the site did not answer", and a message
    // rewording must not turn a permanent host fact into three wasted attempts.
    expect(capability.code).toBe('request_failed');
    expect(classifyCrawlFailure(capability)).toBe('capability');
  });

  it('treats an unrecognised throw as transient', () => {
    expect(classifyCrawlFailure(new Error('renderer crashed'))).toBe('transient');
    expect(classifyCrawlFailure('not an error at all')).toBe('transient');
  });

  it('records a timed-out site as retryable work rather than a decision about the site', async () => {
    const db = fakeSupabase();
    const worker = new KnowledgeImportWorker({
      capabilityPath: () => '/usr/bin/chromium',
      crawlStatic: () =>
        Promise.reject(
          new CrawlPolicyError('request_timeout', 'The website did not respond in time.'),
        ),
      supabase: db.supabase,
    });

    await worker.pollOnce();

    const [failed] = db.callsTo('fail_knowledge_import_as_worker');
    expect(failed?.args['target_failure_kind']).toBe('transient');
    expect(failed?.args['safe_error_code']).toBe('request_timeout');
    expect(worker.lastPass().errorCode).toBe('knowledge_import_failed');
  });

  it('does not let a retryable static failure become a rendered-fallback bypass', async () => {
    // Retrying a transport failure must not turn into "the static crawl failed, so try Chromium".
    // Escalation is still only ever a *completed* static crawl that found nothing; a thrown crawl
    // ends the attempt, and the next attempt starts from static again.
    const db = fakeSupabase();
    const createRenderedSource = vi.fn(() => fakeRenderedSource().source);
    const worker = new KnowledgeImportWorker({
      capabilityPath: () => '/usr/bin/chromium',
      crawlRendered: () => Promise.resolve(crawlResult({ pages: 5 })),
      crawlStatic: () =>
        Promise.reject(new CrawlPolicyError('request_failed', 'The website could not be reached.')),
      createRenderedSource,
      supabase: db.supabase,
    });

    await worker.pollOnce();

    expect(createRenderedSource).not.toHaveBeenCalled();
    expect(db.callsTo('complete_knowledge_import_crawl')).toHaveLength(0);
    expect(db.callsTo('fail_knowledge_import_as_worker')[0]?.args['target_failure_kind']).toBe(
      'transient',
    );
  });
});
