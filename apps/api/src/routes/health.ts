import type { FastifyPluginCallback } from 'fastify';

export const healthRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get('/health', () => ({
    service: 'avenlyo-api',
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  done();
};
