import cors from '@fastify/cors';
import Fastify from 'fastify';

import { env } from './env.js';
import { authPlugin } from './plugins/auth.js';
import { routes } from './routes/index.js';

export function buildApp() {
  const app = Fastify({
    logger: env.NODE_ENV !== 'test',
  });

  void app.register(cors, {
    origin: env.API_CORS_ORIGIN,
  });
  void app.register(authPlugin);
  void app.register(routes);

  return app;
}
