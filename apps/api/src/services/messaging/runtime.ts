import {
  env,
  isEzyVetRuntimeConfigured,
  isGoogleCalendarRuntimeConfigured,
  isTwilioMessagingConfigured,
} from '../../env.js';
import { createServiceSupabaseClient } from '../../lib/supabase.js';
import type { RuntimeComponent } from '../../observability/runtime-state.js';
import type { WorkerObserver } from '../../observability/worker-observer.js';

import { ApiSchedulingConnectorRegistry } from '../scheduling/connector-registry.js';
import { CustomerSchedulingCapabilityService } from '../scheduling/customer-scheduling-capabilities.js';
import { EzyVetIntegrationService } from '../scheduling/ezyvet-service.js';
import { GoogleCalendarIntegrationService } from '../scheduling/google-calendar-service.js';
import { SchedulingBookingService } from '../scheduling/scheduling-booking-service.js';
import { AppointmentLifecycleService } from '../scheduling/appointment-lifecycle-service.js';

import { ConversationAgentService } from './conversation-agent.js';
import { AppointmentReminderWorker } from './appointment-reminder-worker.js';
import { TwilioSdkOutboundClient } from './twilio.js';
import { MessageProcessingWorker } from './worker.js';
import { LeadFollowupWorker } from './lead-followup-worker.js';

export interface MessagingRuntime {
  /** Components this process actually started, so readiness knows what must be alive. */
  readonly components: readonly RuntimeComponent[];
  start(): void;
  stop(): Promise<void>;
}

export interface MessagingRuntimeInput {
  readonly observerFor?: (component: RuntimeComponent) => WorkerObserver;
}

/** Builds no provider clients unless this API process has explicit server-only configuration. */
export function createMessagingRuntime(input: MessagingRuntimeInput = {}): MessagingRuntime | null {
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
  const hasSchedulingProvider = ezyVet !== undefined || googleCalendar !== undefined;
  const scheduling = hasSchedulingProvider
    ? new SchedulingBookingService({ connectors, supabase })
    : undefined;
  const appointmentLifecycle = hasSchedulingProvider
    ? new AppointmentLifecycleService({ connectors, supabase })
    : undefined;
  const schedulingCapabilities = hasSchedulingProvider
    ? new CustomerSchedulingCapabilityService({ connectors, supabase })
    : undefined;
  const agent = env.OPENAI_API_KEY
    ? new ConversationAgentService({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_AGENT_MODEL,
        ...(appointmentLifecycle ? { appointmentLifecycle } : {}),
        ...(scheduling ? { scheduling } : {}),
        ...(schedulingCapabilities ? { schedulingCapabilities } : {}),
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
  const observerFor = input.observerFor;
  const worker = new MessageProcessingWorker({
    ...(agent ? { agent } : {}),
    ...(observerFor ? { observer: observerFor('message_processing') } : {}),
    supabase,
    ...(twilio ? { twilio } : {}),
  });
  const reminders = twilio
    ? new AppointmentReminderWorker({
        connectors,
        ...(observerFor ? { observer: observerFor('appointment_reminders') } : {}),
        supabase,
      })
    : undefined;
  const followups = twilio
    ? new LeadFollowupWorker({
        ...(observerFor ? { observer: observerFor('lead_followups') } : {}),
        supabase,
        twilio,
      })
    : undefined;
  const components: RuntimeComponent[] = ['message_processing'];
  if (reminders) components.push('appointment_reminders');
  if (followups) components.push('lead_followups');
  return {
    components,
    start: () => {
      worker.start();
      reminders?.start();
      followups?.start();
    },
    stop: async () => {
      await Promise.all([worker.stop(), reminders?.stop(), followups?.stop()]);
    },
  };
}
