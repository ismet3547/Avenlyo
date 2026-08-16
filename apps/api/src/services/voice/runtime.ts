import { OpenAIEmbeddingProvider } from '@avenlyo/knowledge';
import { VoiceSessionManager, type VoiceSessionFinalizer } from '@avenlyo/voice';

import { env, isVoiceRuntimeConfigured } from '../../env.js';
import { createVoiceServiceSupabaseClient } from '../../lib/supabase.js';
import { VoiceInboundCallService } from './inbound-service.js';
import { OpenAIRealtimeCallControlProvider } from './openai-realtime-control.js';
import { SupabaseVoiceStore } from './store.js';

export interface VoiceIncomingHandler {
  handleIncoming(
    event: Parameters<VoiceInboundCallService['handleIncoming']>[0],
  ): ReturnType<VoiceInboundCallService['handleIncoming']>;
}

export interface VoiceRuntime {
  readonly inbound: VoiceIncomingHandler;
  shutdown(): Promise<void>;
}

/** Creates no network connections until a verified incoming call reaches the route. */
export function createVoiceRuntime(): VoiceRuntime | null {
  if (!isVoiceRuntimeConfigured || !env.OPENAI_API_KEY) return null;
  const supabase = createVoiceServiceSupabaseClient();
  if (!supabase) return null;
  const control = new OpenAIRealtimeCallControlProvider({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_REALTIME_MODEL,
    ...(env.OPENAI_PROJECT_ID ? { projectId: env.OPENAI_PROJECT_ID } : {}),
  });
  const store = new SupabaseVoiceStore(supabase);
  const finalizer: VoiceSessionFinalizer = {
    finalize: ({ callId, endReason, status }) =>
      store.finalizeCall({ externalCallId: callId, endReason, status }),
  };
  const sessions = new VoiceSessionManager({ control, finalizer });
  const embeddings = new OpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY });
  return {
    inbound: new VoiceInboundCallService({
      control,
      embed: async (query) => {
        const [embedding] = await embeddings.embed([query]);
        if (!embedding) throw new Error('Voice knowledge embedding was empty.');
        return embedding;
      },
      model: env.OPENAI_REALTIME_MODEL,
      sessions,
      store,
    }),
    shutdown: () => sessions.shutdown(),
  };
}
