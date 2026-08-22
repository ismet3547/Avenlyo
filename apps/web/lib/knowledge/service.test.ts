import type * as KnowledgePackage from '@avenlyo/knowledge';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

const run = vi.fn();

// Still mocked, and deliberately so: the point of several tests below is that the web request path
// never reaches a crawler at all. A real one would prove nothing except that the network was slow.
vi.mock('@avenlyo/knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof KnowledgePackage>()),
  KnowledgeImportRunner: class {
    public run = run;
  },
}));

// `./config` imports Next.js's `server-only` marker, which has no resolution outside the Next
// runtime. Only the embedding paths read it, and none of those are under test here.
vi.mock('./config', () => ({
  knowledgeServerEnv: {
    OPENAI_AGENT_MODEL: 'gpt-5.6',
    OPENAI_API_KEY: 'test-key',
    OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small',
  },
}));

const {
  KnowledgeServiceError,
  loadKnowledgeImport,
  loadKnowledgeOverview,
  requestWebsiteImport,
  saveKnowledgeDraft,
} = await import('./service');

type RpcResult = { data: unknown; error: { message: string } | null };

const IMPORT_ID = '10000000-0000-4000-8000-000000000001';

function overviewRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    draft_documents: 0,
    error_message: null,
    finished_at: null,
    import_id: IMPORT_ID,
    pages_discovered: 0,
    pages_imported: 0,
    ready_documents: 0,
    root_url: 'https://clinic.test/',
    started_at: null,
    status: 'pending',
    ...overrides,
  };
}

function clientWith(overrides: Readonly<Record<string, RpcResult>> = {}) {
  const defaults: Record<string, RpcResult> = {
    create_knowledge_import: { data: [{ import_id: IMPORT_ID, status: 'pending' }], error: null },
    get_my_knowledge_overview: { data: [overviewRow()], error: null },
    // The success shape of a `returns void` function.
    update_knowledge_document_draft: { data: null, error: null },
  };
  const rpc = vi.fn((name: string) =>
    Promise.resolve(overrides[name] ?? defaults[name] ?? { data: null, error: null }),
  );
  return { client: { rpc } as unknown as AvenlyoSupabaseClient, rpc };
}

beforeEach(() => {
  run.mockReset();
});

function saveDraft(client: AvenlyoSupabaseClient) {
  return saveKnowledgeDraft(
    client,
    '20000000-0000-4000-8000-000000000001',
    'Hours',
    'We are open daily.',
    true,
  );
}

/**
 * `update_knowledge_document_draft` and `release_knowledge_publish` are `returns void` in SQL and
 * answer a success with null data, which the previous strict guard read as failure.
 */
describe('void knowledge RPCs', () => {
  it('accepts the void success answer when saving a draft', async () => {
    const { client, rpc } = clientWith();
    await expect(saveDraft(client)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('update_knowledge_document_draft', expect.anything());
  });

  it('still fails closed when the draft save reports an error', async () => {
    const { client } = clientWith({
      update_knowledge_document_draft: { data: null, error: { message: 'permission denied' } },
    });
    await expect(saveDraft(client)).rejects.toBeInstanceOf(KnowledgeServiceError);
  });
});

describe('requesting a website import', () => {
  it('creates a durable request and crawls nothing in the web process', async () => {
    const { client, rpc } = clientWith();

    await expect(requestWebsiteImport(client, 'https://clinic.test/', null)).resolves.toBe(
      IMPORT_ID,
    );

    // The whole point of the durable worker: a request handler that crawled inline lost the work
    // whenever the request ended, and could never render a JavaScript-only site.
    expect(run).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('create_knowledge_import', {
      requested_location_id: null,
      root_url_input: 'https://clinic.test/',
    });
  });

  it('never writes crawl state from the browser session', async () => {
    const { client, rpc } = clientWith();

    await requestWebsiteImport(client, 'https://clinic.test/', null);

    // Running, page saving, and failing all belong to the claim-holding worker now.
    for (const name of [
      'start_knowledge_import',
      'save_knowledge_import_pages',
      'fail_knowledge_import',
    ]) {
      expect(rpc).not.toHaveBeenCalledWith(name, expect.anything());
    }
  });

  it('passes the selected location through unchanged', async () => {
    const { client, rpc } = clientWith();
    await requestWebsiteImport(client, 'https://clinic.test/', 'loc-1');
    expect(rpc).toHaveBeenCalledWith('create_knowledge_import', {
      requested_location_id: 'loc-1',
      root_url_input: 'https://clinic.test/',
    });
  });

  it('rejects an import creation that returns no data', async () => {
    const { client } = clientWith({ create_knowledge_import: { data: null, error: null } });
    await expect(requestWebsiteImport(client, 'https://clinic.test/', null)).rejects.toBeInstanceOf(
      KnowledgeServiceError,
    );
  });
});

describe('reading one import', () => {
  it('reports the status the worker last recorded', async () => {
    const { client } = clientWith({
      get_my_knowledge_overview: {
        data: [overviewRow({ pages_imported: 4, status: 'awaiting_review' })],
        error: null,
      },
    });

    const record = await loadKnowledgeImport(client, IMPORT_ID);

    expect(record?.status).toBe('awaiting_review');
    expect(record?.pagesImported).toBe(4);
  });

  it('carries the safe failure message the worker recorded', async () => {
    const { client } = clientWith({
      get_my_knowledge_overview: {
        data: [
          overviewRow({
            error_message: 'This website needs JavaScript rendering, which is not available right now.',
            status: 'failed',
          }),
        ],
        error: null,
      },
    });

    const record = await loadKnowledgeImport(client, IMPORT_ID);

    expect(record?.status).toBe('failed');
    expect(record?.errorMessage).toContain('JavaScript rendering');
  });

  it('answers with nothing for an import this workspace cannot see', async () => {
    // The overview is already tenant-scoped, so an id from another organization simply is not in
    // it. The page turns that into a 404 rather than a differently worded error.
    const { client } = clientWith();
    await expect(
      loadKnowledgeImport(client, '10000000-0000-4000-8000-000000000009'),
    ).resolves.toBeNull();
  });
});

describe('data-returning knowledge RPCs keep their strict null check', () => {
  it('rejects an overview read that returns no data', async () => {
    const { client } = clientWith({ get_my_knowledge_overview: { data: null, error: null } });
    await expect(loadKnowledgeOverview(client)).rejects.toBeInstanceOf(KnowledgeServiceError);
  });
});
