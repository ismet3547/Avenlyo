import type { FastifyPluginAsync } from 'fastify';

import { authenticatedRoutes } from './authenticated.js';
import { healthRoutes } from './health.js';
import { openAIRealtimeWebhookRoutes } from './openai-realtime-webhook.js';

export const routes: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
  await app.register(openAIRealtimeWebhookRoutes);
  await app.register(authenticatedRoutes);
};
