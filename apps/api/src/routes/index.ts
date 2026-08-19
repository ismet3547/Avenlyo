import type { FastifyPluginAsync } from 'fastify';

import type { BillingService } from '../services/billing/billing-service.js';

import { authenticatedRoutes } from './authenticated.js';
import { appointmentLifecycleRoutes } from './appointment-lifecycle.js';
import { ezyVetSchedulingRoutes } from './ezyvet-scheduling.js';
import { googleCalendarSchedulingRoutes } from './google-calendar-scheduling.js';
import { healthRoutes } from './health.js';
import { openAIRealtimeWebhookRoutes } from './openai-realtime-webhook.js';
import { stripeBillingRoutes } from './stripe-billing.js';
import { stripeWebhookRoutes } from './stripe-webhook.js';
import { twilioMessagingWebhookRoutes } from './twilio-messaging-webhook.js';
import { messagingConfigurationRoutes } from './messaging-configuration.js';
import { webChatRoutes } from './web-chat.js';

interface RoutesOptions {
  readonly billingService?: BillingService | null;
}

export const routes: FastifyPluginAsync<RoutesOptions> = async (app, options) => {
  await app.register(healthRoutes);
  await app.register(openAIRealtimeWebhookRoutes);
  await app.register(
    stripeWebhookRoutes,
    options.billingService !== undefined ? { service: options.billingService } : {},
  );
  await app.register(twilioMessagingWebhookRoutes);
  await app.register(webChatRoutes);
  await app.register(messagingConfigurationRoutes);
  await app.register(authenticatedRoutes);
  await app.register(appointmentLifecycleRoutes);
  await app.register(ezyVetSchedulingRoutes);
  await app.register(googleCalendarSchedulingRoutes);
  await app.register(
    stripeBillingRoutes,
    options.billingService !== undefined ? { service: options.billingService } : {},
  );
};
