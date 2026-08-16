import type { FastifyPluginCallback } from 'fastify';

import { env, isEzyVetRuntimeConfigured } from '../env.js';
import { createVoiceServiceSupabaseClient } from '../lib/supabase.js';
import {
  EzyVetIntegrationService,
  SchedulingServiceError,
} from '../services/scheduling/ezyvet-service.js';

function readBody(body: unknown): Record<string, unknown> | null {
  if (!Buffer.isBuffer(body)) return null;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function responseFor(error: unknown): { readonly code: string; readonly message: string; readonly status: number } {
  if (error instanceof SchedulingServiceError) {
    return {
      code: error.code,
      message: error.message,
      status: error.code === 'FORBIDDEN' ? 403 : error.code === 'VALIDATION' ? 422 : 503,
    };
  }
  return { code: 'SCHEDULING_UNAVAILABLE', message: 'Scheduling is temporarily unavailable.', status: 503 };
}

function requireService(): EzyVetIntegrationService | null {
  if (!isEzyVetRuntimeConfigured || !env.EZYVET_PARTNER_ID) return null;
  const supabase = createVoiceServiceSupabaseClient();
  return supabase ? new EzyVetIntegrationService({ partnerId: env.EZYVET_PARTNER_ID, supabase }) : null;
}

/** Authenticated owner/admin routes. Raw ezyVet credentials terminate here and are never echoed. */
export const ezyVetSchedulingRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.post('/v1/scheduling/ezyvet/:locationId/connect', { preHandler: app.authenticate }, async (request, reply) => {
    const locationId = (request.params as { locationId?: string }).locationId;
    const body = readBody(request.body);
    const service = requireService();
    if (!locationId || !validUuid(locationId) || !body) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Connection details are invalid.' });
    }
    if (!service || !request.authUser) {
      return reply.code(503).send({ code: 'SCHEDULING_UNAVAILABLE', message: 'Scheduling is unavailable.' });
    }
    if (
      typeof body.clientId !== 'string' ||
      typeof body.clientSecret !== 'string' ||
      typeof body.siteUid !== 'string' ||
      (body.environment !== 'production' && body.environment !== 'trial')
    ) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Connection details are invalid.' });
    }
    try {
      const connected = await service.connect(request.authUser.id, locationId, {
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        environment: body.environment,
        siteUid: body.siteUid,
      });
      return reply.code(201).send({ connected: true, timezone: connected.timezone });
    } catch (error) {
      const result = responseFor(error);
      return reply.code(result.status).send({ code: result.code, message: result.message });
    }
  });

  app.post('/v1/scheduling/ezyvet/:locationId/catalog-sync', { preHandler: app.authenticate }, async (request, reply) => {
    const locationId = (request.params as { locationId?: string }).locationId;
    const service = requireService();
    if (!locationId || !validUuid(locationId)) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Location is invalid.' });
    }
    if (!service || !request.authUser) {
      return reply.code(503).send({ code: 'SCHEDULING_UNAVAILABLE', message: 'Scheduling is unavailable.' });
    }
    try {
      await service.syncCatalog(request.authUser.id, locationId);
      return reply.code(204).send();
    } catch (error) {
      const result = responseFor(error);
      return reply.code(result.status).send({ code: result.code, message: result.message });
    }
  });

  app.post('/v1/scheduling/ezyvet/:locationId/disconnect', { preHandler: app.authenticate }, async (request, reply) => {
    const locationId = (request.params as { locationId?: string }).locationId;
    const service = requireService();
    if (!locationId || !validUuid(locationId)) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Location is invalid.' });
    }
    if (!service || !request.authUser) {
      return reply.code(503).send({ code: 'SCHEDULING_UNAVAILABLE', message: 'Scheduling is unavailable.' });
    }
    try {
      await service.disconnect(request.authUser.id, locationId);
      return reply.code(204).send();
    } catch (error) {
      const result = responseFor(error);
      return reply.code(result.status).send({ code: result.code, message: result.message });
    }
  });
  done();
};
