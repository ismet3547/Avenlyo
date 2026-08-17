import { env, isTwilioMessagingConfigured } from '../../env.js';
import { createServiceSupabaseClient } from '../../lib/supabase.js';

import { ConversationAgentService } from './conversation-agent.js';
import { TwilioSdkOutboundClient } from './twilio.js';
import { MessageProcessingWorker } from './worker.js';

export interface MessagingRuntime {
  start(): void;
  stop(): Promise<void>;
}

/** Builds no provider clients unless this API process has explicit server-only configuration. */
export function createMessagingRuntime(): MessagingRuntime | null {
  const supabase = createServiceSupabaseClient();
  if (!supabase) return null;
  const agent = env.OPENAI_API_KEY
    ? new ConversationAgentService({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_AGENT_MODEL,
        supabase,
      })
    : undefined;
  const twilio =
    isTwilioMessagingConfigured &&
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    env.TWILIO_MESSAGING_WEBHOOK_BASE_URL
      ? new TwilioSdkOutboundClient({
          accountSid: env.TWILIO_ACCOUNT_SID,
          authToken: env.TWILIO_AUTH_TOKEN,
          webhookBaseUrl: env.TWILIO_MESSAGING_WEBHOOK_BASE_URL,
        })
      : undefined;
  if (!agent && !twilio) return null;
  const worker = new MessageProcessingWorker({
    ...(agent ? { agent } : {}),
    supabase,
    ...(twilio ? { twilio } : {}),
  });
  return { start: () => worker.start(), stop: () => worker.stop() };
}
