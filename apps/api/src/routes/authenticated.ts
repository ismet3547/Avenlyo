import type { FastifyPluginCallback } from 'fastify';

export const authenticatedRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get('/v1/me', { preHandler: app.authenticate }, (request) => ({
    message: 'Authenticated API placeholder.',
    userId: request.authUser?.id,
  }));

  done();
};
