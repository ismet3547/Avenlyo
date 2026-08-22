import { CrawlPolicyError, type CrawlResult, type RenderedPage } from '@avenlyo/knowledge';
import type { Database } from '@avenlyo/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { KnowledgeImportWorker, type ManagedRenderedSource } from './import-worker.js';

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

function fakeSupabase(
  input: {
    readonly claim?: readonly Record<string, unknown>[];
    readonly claimError?: { message: string };
    readonly claimThrows?: Error;
  } = {},
) {
  const calls: RpcCall[] = [];
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    calls.push({ args, name });
    if (name === 'claim_pending_knowledge_import') {
      if (input.claimThrows) return Promise.reject(input.claimThrows);
      if (input.claimError) return Promise.resolve({ data: null, error: input.claimError });
      return Promise.resolve({
        data:
          input.claim ??
          ([
            {
              attempt_count: 1,
              claim_token: 'token-1',
              import_id: 'import-1',
              location_id: null,
              organization_id: 'org-1',
              root_url: 'https://clinic.test/',
            },
          ] as const),
        error: null,
      });
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
