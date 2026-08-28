import { createHash, randomBytes } from 'node:crypto';

import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { env } from '../env.js';
import { createServiceSupabaseClient } from '../lib/supabase.js';
import { canonicalClientAddress, UNRESOLVED_CLIENT_LABEL } from '../security/client-identity.js';
import {
  BODY_LIMITS,
  EDGE_POLICIES,
  edgeKey,
  logRateLimited,
  tooManyRequestsBody,
  type EdgePolicy,
} from '../security/edge-policy.js';

const sessionPayload = z.object({ widgetPublicKey: z.string().uuid() }).strict();
const messagePayload = z
  .object({
    body: z.string().trim().min(1).max(2000),
    clientMessageId: z.string().uuid(),
  })
  .strict();
const pollQuery = z
  .object({
    after: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

function bodyAsJson(request: FastifyRequest): unknown {
  const value = request.body;
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8')) as unknown;
  if (typeof value === 'string') return JSON.parse(value) as unknown;
  return value;
}

function originHeader(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  return typeof origin === 'string' && origin.length <= 300 ? origin : null;
}

function chatTokenHeader(request: FastifyRequest): string | null {
  const token = request.headers['x-avenlyo-chat-token'];
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The durable quota's identity for this caller.
 *
 * `request.ip` is now the real client, because `buildApp` trusts a forwarding header only from an
 * internal peer. Before that it was the socket peer, which behind Caddy is Caddy -- so every
 * visitor on the internet hashed to the same value and Phase 7's per-client quotas behaved as one
 * global quota that a single abuser could exhaust for every tenant at once. Canonicalising first
 * bounds the key space: an IPv6 client cannot rotate through its /64 to mint fresh identities.
 */
function rateScope(request: FastifyRequest, prefix: string): string {
  const client = canonicalClientAddress(request.ip) ?? UNRESOLVED_CLIENT_LABEL;
  return createHash('sha256').update(`${prefix}:${client}`).digest('hex');
}

/** Per-route edge policy, shaped for @fastify/rate-limit's route config. */
function edgeLimit(policy: EdgePolicy) {
  return {
    rateLimit: {
      errorResponseBuilder: (request: FastifyRequest) => tooManyRequestsBody(request),
      keyGenerator: (request: FastifyRequest) => edgeKey(policy, request),
      max: policy.max,
      onExceeded: (request: FastifyRequest) => {
        logRateLimited(request, policy, request.routeOptions?.url ?? 'unmatched');
      },
      timeWindow: policy.timeWindowMs,
    },
  };
}

function setPublicCors(
  reply: { header(name: string, value: string): unknown },
  origin: string,
): void {
  reply.header('Access-Control-Allow-Origin', origin);
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type');
  reply.header('Vary', 'Origin');
}

function isIframeOrigin(origin: string): boolean {
  return origin === env.WEB_CHAT_IFRAME_ORIGIN;
}

/** Public API surface for the iframe only. Its opaque session token is never a Supabase credential. */
export const webChatRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.options('/v1/chat/:path', async (request, reply) => {
    const origin = originHeader(request);
    if (!origin) return reply.code(400).send();
    // The session request is later authoritatively checked against the widget's configured
    // origin. Iframe traffic is additionally constrained to Avenlyo's deployed web origin.
    const path = (request.params as { readonly path?: string }).path;
    if (path === 'messages' && !isIframeOrigin(origin)) {
      return reply.code(403).send();
    }
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Avenlyo-Chat-Token');
    reply.header('Vary', 'Origin');
    return reply.code(204).send();
  });

  app.post(
    '/v1/chat/session',
    { bodyLimit: BODY_LIMITS.webChatSession, config: edgeLimit(EDGE_POLICIES.webChatSession) },
    async (request, reply) => {
      const origin = originHeader(request);
      const parsed = sessionPayload.safeParse(safelyReadJson(request));
      if (!origin || !parsed.success)
        return reply.code(400).send({ code: 'INVALID_WEB_CHAT_REQUEST' });
      const supabase = createServiceSupabaseClient();
      if (!supabase) return reply.code(503).send({ code: 'CHAT_NOT_CONFIGURED' });
      const token = randomBytes(32).toString('base64url');
      const { data, error } = await supabase.rpc('create_web_chat_session', {
        target_origin: origin,
        target_rate_scope: rateScope(request, `session:${parsed.data.widgetPublicKey}`),
        target_token_hash: tokenHash(token),
        target_widget_public_key: parsed.data.widgetPublicKey,
      });
      if (error || !data[0]) {
        const status = error?.code === '42901' ? 429 : error?.code === '42501' ? 403 : 400;
        return reply.code(status).send({ code: 'WEB_CHAT_SESSION_REJECTED' });
      }
      setPublicCors(reply, origin);
      return reply.code(201).send({
        conversationId: data[0].conversation_id,
        expiresInSeconds: 86_400,
        token,
        welcomeMessage: data[0].welcome_message,
      });
    },
  );

  app.post(
    '/v1/chat/messages',
    { bodyLimit: BODY_LIMITS.webChatMessage, config: edgeLimit(EDGE_POLICIES.webChatMessage) },
    async (request, reply) => {
      const origin = originHeader(request);
      const parsed = messagePayload.safeParse(safelyReadJson(request));
      const token = chatTokenHeader(request);
      if (!origin || !isIframeOrigin(origin) || !token || !parsed.success)
        return reply.code(400).send({ code: 'INVALID_WEB_CHAT_REQUEST' });
      const supabase = createServiceSupabaseClient();
      if (!supabase) return reply.code(503).send({ code: 'CHAT_NOT_CONFIGURED' });
      const { data, error } = await supabase.rpc('append_web_chat_message', {
        target_body: parsed.data.body,
        target_client_message_id: parsed.data.clientMessageId,
        target_rate_scope: rateScope(request, 'message'),
        target_token_hash: tokenHash(token),
      });
      if (error || !data[0]) {
        const status = error?.code === '42901' ? 429 : error?.code === '42501' ? 403 : 400;
        return reply.code(status).send({ code: 'WEB_CHAT_MESSAGE_REJECTED' });
      }
      setPublicCors(reply, origin);
      return reply.code(data[0].is_duplicate ? 200 : 202).send({
        conversationId: data[0].conversation_id,
        duplicate: data[0].is_duplicate,
        messageId: data[0].message_id,
      });
    },
  );

  app.get(
    '/v1/chat/messages',
    { config: edgeLimit(EDGE_POLICIES.webChatPoll) },
    async (request, reply) => {
      const origin = originHeader(request);
      const parsed = pollQuery.safeParse(request.query);
      const token = chatTokenHeader(request);
      if (!origin || !isIframeOrigin(origin) || !token || !parsed.success)
        return reply.code(400).send({ code: 'INVALID_WEB_CHAT_REQUEST' });
      const supabase = createServiceSupabaseClient();
      if (!supabase) return reply.code(503).send({ code: 'CHAT_NOT_CONFIGURED' });
      const { data, error } = await supabase.rpc('get_web_chat_messages', {
        target_after: parsed.data.after ?? null,
        target_rate_scope: rateScope(request, 'poll'),
        target_token_hash: tokenHash(token),
      });
      if (error)
        return reply
          .code(error.code === '42901' ? 429 : error.code === '42501' ? 403 : 400)
          .send({ code: 'WEB_CHAT_POLL_REJECTED' });
      setPublicCors(reply, origin);
      return reply.send({
        messages: data.map((message) => ({
          authorType: message.author_type,
          body: message.body,
          createdAt: message.created_at,
          direction: message.direction,
          id: message.message_id,
        })),
      });
    },
  );
  done();
};

function safelyReadJson(request: FastifyRequest): unknown {
  try {
    return bodyAsJson(request);
  } catch {
    return null;
  }
}
