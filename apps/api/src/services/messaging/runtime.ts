import {
  env,
  isEzyVetRuntimeConfigured,
  isGoogleCalendarRuntimeConfigured,
  isTwilioMessagingConfigured,
} from '../../env.js';
import { createServiceSupabaseClient } from '../../lib/supabase.js';

import { ApiSchedulingConnectorRegistry } from '../scheduling/connector-registry.js';
import { EzyVetIntegrationService } from '../scheduling/ezyvet-service.js';
import { GoogleCalendarIntegrationService } from '../scheduling/google-calendar-service.js';
import { SchedulingBookingService } from '../scheduling/scheduling-booking-service.js';

import { ConversationAgentService } from './conversation-agent.js';
import { AppointmentReminderWorker } from './appointment-reminder-worker.js';
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
  const ezyVet =
    isEzyVetRuntimeConfigured && env.EZYVET_PARTNER_ID
      ? new EzyVetIntegrationService({ partnerId: env.EZYVET_PARTNER_ID, supabase })
      : undefined;
  const googleCalendar =
    isGoogleCalendarRuntimeConfigured &&
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET &&
    env.GOOGLE_OAUTH_REDIRECT_URI
      ? new GoogleCalendarIntegrationService({
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          oauthRedirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
          supabase,
        })
      : undefined;
  const connectors = new ApiSchedulingConnectorRegistry({
    ...(ezyVet ? { ezyVet } : {}),
    ...(googleCalendar ? { googleCalendar } : {}),
  });
  const scheduling =
    ezyVet || googleCalendar ? new SchedulingBookingService({ connectors, supabase }) : undefined;
  const agent = env.OPENAI_API_KEY
    ? new ConversationAgentService({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_AGENT_MODEL,
        ...(scheduling ? { scheduling } : {}),
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
  const reminders = twilio ? new AppointmentReminderWorker({ connectors, supabase }) : undefined;
  return {
    start: () => {
      worker.start();
      reminders?.start();
    },
    stop: async () => {
      await Promise.all([worker.stop(), reminders?.stop()]);
    },
  };
}
