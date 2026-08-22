import { createHash } from 'node:crypto';

import type { Json } from '@avenlyo/database';
import {
  chunkKnowledgeContent,
  embedInBatches,
  EmbeddingConfigurationError,
  OpenAIEmbeddingProvider,
} from '@avenlyo/knowledge';
import { z } from 'zod';

import { createRpcGuards, type RpcError } from '@/lib/supabase/rpc';
import type { AvenlyoSupabaseClient } from '@/lib/supabase/server';

import type { KnowledgeDraftDocument, KnowledgeOverview, KnowledgeSearchMatch } from './types';
import { knowledgeServerEnv } from './config';

interface KnowledgeRpcCaller {
  (
    name: 'create_knowledge_import',
    args: { requested_location_id: string | null; root_url_input: string },
  ): PromiseLike<{ data: { import_id: string; status: string }[] | null; error: RpcError | null }>;
  (
    name: 'update_knowledge_document_draft',
    args: {
      draft_content: string;
      draft_title: string;
      is_included: boolean;
      target_document_id: string;
    },
  ): PromiseLike<{ data: null; error: RpcError | null }>;
  (
    name: 'begin_knowledge_publish',
    args: { target_import_id: string },
  ): PromiseLike<{
    data:
      | {
          content: string;
          content_hash: string;
          document_id: string;
          source_url: string;
          title: string;
        }[]
      | null;
    error: RpcError | null;
  }>;
  (
    name: 'complete_knowledge_publish',
    args: { document_versions: Json; generated_chunks: Json; target_import_id: string },
  ): PromiseLike<{ data: number | null; error: RpcError | null }>;
  (
    name: 'release_knowledge_publish',
    args: { safe_error_code: string; safe_error_message: string; target_import_id: string },
  ): PromiseLike<{ data: null; error: RpcError | null }>;
  (name: 'get_my_knowledge_overview'): PromiseLike<{
    data:
      | {
          draft_documents: number;
          error_message: string | null;
          finished_at: string | null;
          import_id: string;
          pages_discovered: number;
          pages_imported: number;
          ready_documents: number;
          root_url: string;
          started_at: string | null;
          status: string;
        }[]
      | null;
    error: RpcError | null;
  }>;
  (
    name: 'get_knowledge_import_review',
    args: { target_import_id: string },
  ): PromiseLike<{
    data:
      | {
          canonical_url: string;
          content: string;
          document_id: string;
          included: boolean;
          status: string;
          title: string;
        }[]
      | null;
    error: RpcError | null;
  }>;
  (
    name: 'match_my_knowledge',
    args: {
      query_embedding_text: string;
      requested_location_id: string | null;
      requested_match_count: number;
    },
  ): PromiseLike<{
    data:
      | {
          chunk_id: string;
          content: string;
          document_id: string;
          similarity: number;
          source_url: string;
          title: string;
        }[]
      | null;
    error: RpcError | null;
  }>;
}

function knowledgeRpc(client: AvenlyoSupabaseClient): KnowledgeRpcCaller {
  // Keep Supabase's older generic binding isolated from the app's precise RPC surface.
  return client.rpc.bind(client);
}

export class KnowledgeServiceError extends Error {
  public constructor(message = 'This knowledge operation could not be completed.') {
    super(message);
    this.name = 'KnowledgeServiceError';
  }
}

// `update_knowledge_document_draft` and `release_knowledge_publish` are `returns void` in SQL, so
// PostgREST answers a success with null data. They go through requireVoidRpc.
// `complete_knowledge_publish` returns an integer and keeps the strict guard, as does every read.
const { requireRpcData, requireVoidRpc } = createRpcGuards(() => new KnowledgeServiceError());

const statusSchema = z.enum([
  'pending',
  'running',
  'awaiting_review',
  'publishing',
  'completed',
  'failed',
]);

export async function loadKnowledgeOverview(
  client: AvenlyoSupabaseClient,
): Promise<readonly KnowledgeOverview[]> {
  const rows = await requireRpcData(knowledgeRpc(client)('get_my_knowledge_overview'));
  return rows.map((row) => ({
    draftDocuments: row.draft_documents,
    errorMessage: row.error_message,
    finishedAt: row.finished_at,
    id: row.import_id,
    pagesDiscovered: row.pages_discovered,
    pagesImported: row.pages_imported,
    readyDocuments: row.ready_documents,
    rootUrl: row.root_url,
    startedAt: row.started_at,
    status: statusSchema.parse(row.status),
  }));
}

export async function loadKnowledgeReview(
  client: AvenlyoSupabaseClient,
  importId: string,
): Promise<readonly KnowledgeDraftDocument[]> {
  const rows = await requireRpcData(
    knowledgeRpc(client)('get_knowledge_import_review', { target_import_id: importId }),
  );
  return rows.map((row) => ({
    canonicalUrl: row.canonical_url,
    content: row.content,
    id: row.document_id,
    included: row.included,
    status: z.enum(['draft', 'ready', 'archived']).parse(row.status),
    title: row.title,
  }));
}

/**
 * Enqueues a website import and returns immediately.
 *
 * Nothing is crawled here. A request handler that fetched a whole website inline died with the
 * request: a slow site, a deployment, or a closed tab lost the work with no record of it, and a
 * site needing a browser could never be handled at all, because a Next.js server has no business
 * launching Chromium. The row this creates is the durable unit of work, and the API worker claims
 * it under a lease.
 */
export async function requestWebsiteImport(
  client: AvenlyoSupabaseClient,
  rootUrl: string,
  locationId: string | null,
): Promise<string> {
  const created = await requireRpcData(
    knowledgeRpc(client)('create_knowledge_import', {
      requested_location_id: locationId,
      root_url_input: rootUrl,
    }),
  );
  const importId = created[0]?.import_id;
  if (!importId) throw new KnowledgeServiceError();
  return importId;
}

/** One import's own state, for the review page that has to know whether there is anything yet. */
export async function loadKnowledgeImport(
  client: AvenlyoSupabaseClient,
  importId: string,
): Promise<KnowledgeOverview | null> {
  const imports = await loadKnowledgeOverview(client);
  return imports.find((item) => item.id === importId) ?? null;
}

export async function saveKnowledgeDraft(
  client: AvenlyoSupabaseClient,
  documentId: string,
  title: string,
  content: string,
  included: boolean,
): Promise<void> {
  await requireVoidRpc(
    knowledgeRpc(client)('update_knowledge_document_draft', {
      draft_content: content,
      draft_title: title,
      is_included: included,
      target_document_id: documentId,
    }),
  );
}

function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

function createEmbeddingProvider(): OpenAIEmbeddingProvider {
  return knowledgeServerEnv.OPENAI_API_KEY
    ? new OpenAIEmbeddingProvider({
        apiKey: knowledgeServerEnv.OPENAI_API_KEY,
        model: knowledgeServerEnv.OPENAI_EMBEDDING_MODEL,
      })
    : new OpenAIEmbeddingProvider({ model: knowledgeServerEnv.OPENAI_EMBEDDING_MODEL });
}

export async function publishKnowledgeImport(
  client: AvenlyoSupabaseClient,
  importId: string,
): Promise<number> {
  const documents = await requireRpcData(
    knowledgeRpc(client)('begin_knowledge_publish', {
      target_import_id: importId,
    }),
  );
  try {
    if (documents.length === 0) {
      throw new KnowledgeServiceError('Include at least one knowledge page before publishing.');
    }

    let provider: OpenAIEmbeddingProvider;
    try {
      provider = createEmbeddingProvider();
    } catch (error) {
      if (error instanceof EmbeddingConfigurationError)
        throw new KnowledgeServiceError(error.message);
      throw error;
    }

    const draftedChunks = documents.flatMap((document) =>
      chunkKnowledgeContent(document.content).map((chunk) => ({ ...chunk, document })),
    );
    if (draftedChunks.length === 0)
      throw new KnowledgeServiceError('Included knowledge needs more text.');
    const embeddings = await embedInBatches(
      provider,
      draftedChunks.map((chunk) => chunk.content),
    );

    const chunks: Json = draftedChunks.map((chunk, index) => ({
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
      content_hash: createHash('sha256').update(chunk.content).digest('hex'),
      document_id: chunk.document.document_id,
      embedding: vectorLiteral(embeddings[index]!),
      embedding_model: provider.model,
      embedding_provider: provider.id,
    }));
    const versions: Json = documents.map((document) => ({
      content_hash: document.content_hash,
      document_id: document.document_id,
    }));
    return await requireRpcData(
      knowledgeRpc(client)('complete_knowledge_publish', {
        document_versions: versions,
        generated_chunks: chunks,
        target_import_id: importId,
      }),
    );
  } catch (error) {
    // The reservation is recoverable: no database transaction is kept open during OpenAI I/O.
    try {
      await requireVoidRpc(
        knowledgeRpc(client)('release_knowledge_publish', {
          safe_error_code: 'publication_failed',
          safe_error_message: 'Knowledge could not be published right now. Please try again.',
          target_import_id: importId,
        }),
      );
    } catch {
      // A completed/released reservation needs no further action; stale reservations have a safe RPC.
    }
    throw error;
  }
}

export async function searchKnowledge(
  client: AvenlyoSupabaseClient,
  question: string,
  locationId: string | null,
): Promise<readonly KnowledgeSearchMatch[]> {
  let provider: OpenAIEmbeddingProvider;
  try {
    provider = createEmbeddingProvider();
  } catch (error) {
    if (error instanceof EmbeddingConfigurationError)
      throw new KnowledgeServiceError(error.message);
    throw error;
  }
  const [embedding] = await embedInBatches(provider, [question]);
  if (!embedding) throw new KnowledgeServiceError();
  const matches = await requireRpcData(
    knowledgeRpc(client)('match_my_knowledge', {
      query_embedding_text: vectorLiteral(embedding),
      requested_location_id: locationId,
      requested_match_count: 5,
    }),
  );
  return matches.map((match) => ({
    chunkId: match.chunk_id,
    content: match.content,
    documentId: match.document_id,
    similarity: match.similarity,
    sourceUrl: match.source_url,
    title: match.title,
  }));
}
