import type { FastifyPluginAsync } from 'fastify';

import { authenticatedRoutes } from './authenticated.js';
import { healthRoutes } from './health.js';

export const routes: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
  await app.register(authenticatedRoutes);
};
