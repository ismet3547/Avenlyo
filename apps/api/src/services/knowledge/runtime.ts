import { env } from '../../env.js';
import { createServiceSupabaseClient } from '../../lib/supabase.js';
import type { RuntimeComponent } from '../../observability/runtime-state.js';
import type { WorkerObserver } from '../../observability/worker-observer.js';

import { KnowledgeImportWorker } from './import-worker.js';

export interface KnowledgeRuntime {
  readonly components: readonly RuntimeComponent[];
  start(): void;
  stop(): Promise<void>;
}

export interface KnowledgeRuntimeInput {
  readonly observerFor?: (component: RuntimeComponent) => WorkerObserver;
}

/**
 * Website imports run wherever the trusted backend boundary exists, and nowhere else.
 *
 * There is deliberately no rendering capability check here. Rendering is decided per import, at the
 * moment a static crawl comes back empty, because a host can gain or lose a browser binary between
 * deployments while the queue stays the same. Gating the whole worker on Chromium would strand
 * every static import on a host that simply has no browser.
 */
export function createKnowledgeRuntime(input: KnowledgeRuntimeInput = {}): KnowledgeRuntime | null {
  const supabase = createServiceSupabaseClient();
  if (!supabase) return null;
  const observer = input.observerFor?.('knowledge_imports');
  const worker = new KnowledgeImportWorker({
    ...(observer ? { observer } : {}),
    ...(env.KNOWLEDGE_RENDERER_EXECUTABLE_PATH
      ? { renderedExecutablePath: env.KNOWLEDGE_RENDERER_EXECUTABLE_PATH }
      : {}),
    supabase,
  });
  return {
    components: ['knowledge_imports'],
    start: () => worker.start(),
    stop: () => worker.stop(),
  };
}
