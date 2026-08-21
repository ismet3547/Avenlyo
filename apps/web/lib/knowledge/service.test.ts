import type * as KnowledgePackage from '@avenlyo/knowledge';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

const run = vi.fn();

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

const { importWebsiteKnowledge, KnowledgeServiceError, loadKnowledgeOverview, saveKnowledgeDraft } =
  await import('./service');

type RpcResult = { data: unknown; error: { message: string } | null };

function clientWith(overrides: Readonly<Record<string, RpcResult>> = {}) {
  const defaults: Record<string, RpcResult> = {
    create_knowledge_import: {
      data: [{ import_id: '10000000-0000-4000-8000-000000000001', status: 'pending' }],
      error: null,
    },
    fail_knowledge_import: { data: null, error: null },
    save_knowledge_import_pages: { data: 3, error: null },
    // The success shape of a `returns void` function.
    start_knowledge_import: { data: null, error: null },
    update_knowledge_document_draft: { data: null, error: null },
  };
  const rpc = vi.fn((name: string) =>
    Promise.resolve(overrides[name] ?? defaults[name] ?? { data: null, error: null }),
  );
  return { client: { rpc } as unknown as AvenlyoSupabaseClient, rpc };
}

const CRAWL_RESULT = {
  pages: [
    {
      canonicalUrl: 'https://clinic.test/',
      content: 'Open daily.',
      contentHash: 'h',
      title: 'Home',
    },
  ],
  pagesDiscovered: 1,
  pagesSkipped: 0,
  rootUrl: 'https://clinic.test/',
};

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
 * Knowledge has the same `returns void` contract as Agent Test: `start_knowledge_import`,
 * `fail_knowledge_import`, `update_knowledge_document_draft`, and `release_knowledge_publish`
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

  it('accepts the void success answer when starting an import', async () => {
    run.mockResolvedValue(CRAWL_RESULT);
    const { client, rpc } = clientWith();

    await expect(importWebsiteKnowledge(client, 'https://clinic.test/', null)).resolves.toBe(
      '10000000-0000-4000-8000-000000000001',
    );
    expect(rpc).toHaveBeenCalledWith('start_knowledge_import', expect.anything());
    // A successful import must not be marked failed on the way out.
    expect(rpc).not.toHaveBeenCalledWith('fail_knowledge_import', expect.anything());
  });

  it('still fails closed when starting an import reports an error', async () => {
    run.mockResolvedValue(CRAWL_RESULT);
    const { client, rpc } = clientWith({
      start_knowledge_import: { data: null, error: { message: 'conflict' } },
    });

    await expect(
      importWebsiteKnowledge(client, 'https://clinic.test/', null),
    ).rejects.toBeInstanceOf(KnowledgeServiceError);
    // The failure happened before the crawl, so nothing was crawled.
    expect(run).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith('save_knowledge_import_pages', expect.anything());
  });
});

describe('data-returning knowledge RPCs keep their strict null check', () => {
  it('rejects an overview read that returns no data', async () => {
    const { client } = clientWith({ get_my_knowledge_overview: { data: null, error: null } });
    await expect(loadKnowledgeOverview(client)).rejects.toBeInstanceOf(KnowledgeServiceError);
  });

  it('rejects an import creation that returns no data', async () => {
    const { client } = clientWith({ create_knowledge_import: { data: null, error: null } });
    await expect(
      importWebsiteKnowledge(client, 'https://clinic.test/', null),
    ).rejects.toBeInstanceOf(KnowledgeServiceError);
  });

  it('rejects a page save that returns no count, and records the failure safely', async () => {
    run.mockResolvedValue(CRAWL_RESULT);
    const { client, rpc } = clientWith({
      save_knowledge_import_pages: { data: null, error: null },
    });

    await expect(
      importWebsiteKnowledge(client, 'https://clinic.test/', null),
    ).rejects.toBeInstanceOf(KnowledgeServiceError);
    expect(rpc).toHaveBeenCalledWith('fail_knowledge_import', {
      safe_error_code: 'import_failed',
      safe_error_message: 'Knowledge import could not be completed.',
      target_import_id: '10000000-0000-4000-8000-000000000001',
    });
  });

  it('accepts a zero page count as a real answer', async () => {
    run.mockResolvedValue({ ...CRAWL_RESULT, pages: [], pagesDiscovered: 0 });
    const { client } = clientWith({ save_knowledge_import_pages: { data: 0, error: null } });
    await expect(importWebsiteKnowledge(client, 'https://clinic.test/', null)).resolves.toBe(
      '10000000-0000-4000-8000-000000000001',
    );
  });
});
