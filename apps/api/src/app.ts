import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';

import { env } from './env.js';
import { authPlugin } from './plugins/auth.js';
import { routes } from './routes/index.js';

export function buildApp() {
  const app = Fastify({
    logger: env.NODE_ENV !== 'test',
  });

  // OpenAI signs the exact bytes it sends. Keep JSON bodies as a buffer until the public
  // webhook route has verified its signature; other current API routes do not accept JSON bodies.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  void app.register(formbody);

  void app.register(cors, {
    origin: env.API_CORS_ORIGIN,
  });
  void app.register(authPlugin);
  void app.register(routes);

  return app;
}
