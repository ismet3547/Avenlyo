import type { FastifyPluginCallback } from 'fastify';

import { env, isGoogleCalendarRuntimeConfigured } from '../env.js';
import { createVoiceServiceSupabaseClient } from '../lib/supabase.js';
import { SchedulingServiceError } from '../services/scheduling/ezyvet-service.js';
import { GoogleCalendarIntegrationService } from '../services/scheduling/google-calendar-service.js';

function validUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}
function service(): GoogleCalendarIntegrationService | null {
  if (!isGoogleCalendarRuntimeConfigured || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URI) return null;
  const supabase = createVoiceServiceSupabaseClient();
  return supabase ? new GoogleCalendarIntegrationService({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, oauthRedirectUri: env.GOOGLE_OAUTH_REDIRECT_URI, supabase }) : null;
}
function replyError(error: unknown): { readonly code: string; readonly message: string; readonly status: number } {
  if (error instanceof SchedulingServiceError) return { code: error.code, message: error.message, status: error.code === 'FORBIDDEN' ? 403 : error.code === 'VALIDATION' ? 422 : 503 };
  return { code: 'SCHEDULING_UNAVAILABLE', message: 'Scheduling is temporarily unavailable.', status: 503 };
}

/** OAuth state and tokens terminate here. Browser routes receive only redirects and status. */
export const googleCalendarSchedulingRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.post('/v1/scheduling/google-calendar/:locationId/connect', { preHandler: app.authenticate }, async (request, reply) => {
    const locationId = (request.params as { locationId?: string }).locationId;
    const google = service();
    if (!validUuid(locationId) || !google || !request.authUser) return reply.code(503).send({ code: 'SCHEDULING_UNAVAILABLE', message: 'Google Calendar is unavailable.' });
    try { return reply.send({ authorizationUrl: await google.beginConnection(request.authUser.id, locationId) }); }
    catch (error) { const result = replyError(error); return reply.code(result.status).send(result); }
  });

  app.get('/v1/scheduling/google-calendar/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    const google = service();
    if (!google || !query.code || !query.state) return reply.code(400).type('text/plain').send('Google Calendar authorization could not be completed.');
    try {
      await google.completeConnection(query.code, query.state);
      return reply.redirect(`${env.API_CORS_ORIGIN}/dashboard/integrations?google=connected`);
    } catch { return reply.code(400).type('text/plain').send('Google Calendar authorization could not be completed.'); }
  });

  app.post('/v1/scheduling/google-calendar/:locationId/discover', { preHandler: app.authenticate }, async (request, reply) => {
    const locationId = (request.params as { locationId?: string }).locationId; const google = service();
    if (!validUuid(locationId) || !google || !request.authUser) return reply.code(503).send({ code: 'SCHEDULING_UNAVAILABLE', message: 'Google Calendar is unavailable.' });
    try { await google.discover(request.authUser.id, locationId); return reply.code(204).send(); }
    catch (error) { const result = replyError(error); return reply.code(result.status).send(result); }
  });

  app.post('/v1/scheduling/google-calendar/:locationId/disconnect', { preHandler: app.authenticate }, async (request, reply) => {
    const locationId = (request.params as { locationId?: string }).locationId; const google = service();
    if (!validUuid(locationId) || !google || !request.authUser) return reply.code(503).send({ code: 'SCHEDULING_UNAVAILABLE', message: 'Google Calendar is unavailable.' });
    try { await google.disconnect(request.authUser.id, locationId); return reply.code(204).send(); }
    catch (error) { const result = replyError(error); return reply.code(result.status).send(result); }
  });
  done();
};
