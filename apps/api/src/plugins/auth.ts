import type { User } from '@supabase/supabase-js';
import type { FastifyPluginCallback, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';

import { createApiSupabaseClient } from '../lib/supabase.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: preHandlerHookHandler;
  }

  interface FastifyRequest {
    authUser: User | null;
  }
}

const authPluginImplementation: FastifyPluginCallback = (app, _options, done) => {
  const supabase = createApiSupabaseClient();

  app.decorateRequest('authUser', null);
  app.decorate('authenticate', async (request, reply) => {
    if (!supabase) {
      await reply.code(503).send({
        code: 'AUTH_NOT_CONFIGURED',
        message: 'Supabase credentials are required before authenticated routes can be used.',
      });
      return;
    }

    const authorization = request.headers.authorization;

    if (!authorization?.startsWith('Bearer ')) {
      await reply.code(401).send({ code: 'UNAUTHORIZED', message: 'A bearer token is required.' });
      return;
    }

    const token = authorization.slice('Bearer '.length);
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      await reply.code(401).send({ code: 'UNAUTHORIZED', message: 'The bearer token is invalid.' });
      return;
    }

    request.authUser = data.user;
  });

  done();
};

/** Shared at the application level so every route can use the authentication pre-handler. */
export const authPlugin = fp(authPluginImplementation, { name: 'auth' });
