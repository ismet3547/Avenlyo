import type { FastifyPluginAsync } from 'fastify';

import { authenticatedRoutes } from './authenticated.js';
import { appointmentLifecycleRoutes } from './appointment-lifecycle.js';
import { ezyVetSchedulingRoutes } from './ezyvet-scheduling.js';
import { googleCalendarSchedulingRoutes } from './google-calendar-scheduling.js';
import { healthRoutes } from './health.js';
import { openAIRealtimeWebhookRoutes } from './openai-realtime-webhook.js';
import { twilioMessagingWebhookRoutes } from './twilio-messaging-webhook.js';
import { messagingConfigurationRoutes } from './messaging-configuration.js';
import { webChatRoutes } from './web-chat.js';

export const routes: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
  await app.register(openAIRealtimeWebhookRoutes);
  await app.register(twilioMessagingWebhookRoutes);
  await app.register(webChatRoutes);
  await app.register(messagingConfigurationRoutes);
  await app.register(authenticatedRoutes);
  await app.register(appointmentLifecycleRoutes);
  await app.register(ezyVetSchedulingRoutes);
  await app.register(googleCalendarSchedulingRoutes);
};
