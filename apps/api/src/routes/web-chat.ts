import { createHash, randomBytes } from 'node:crypto';

import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createServiceSupabaseClient } from '../lib/supabase.js';

const sessionPayload = z.object({ widgetPublicKey: z.string().uuid() }).strict();
const messagePayload = z
  .object({
    body: z.string().trim().min(1).max(2000),
    clientMessageId: z.string().uuid(),
    parentOrigin: z.string().max(300),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
const pollQuery = z
  .object({
    after: z.string().datetime({ offset: true }).optional(),
    parentOrigin: z.string().max(300),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
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

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function rateScope(request: FastifyRequest, prefix: string): string {
  return createHash('sha256').update(`${prefix}:${request.ip}`).digest('hex');
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

/** Public API surface for the iframe only. Its opaque session token is never a Supabase credential. */
export const webChatRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.options('/v1/chat/:path', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type');
    return reply.code(204).send();
  });

  app.post('/v1/chat/session', async (request, reply) => {
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
  });

  app.post('/v1/chat/messages', async (request, reply) => {
    const origin = originHeader(request);
    const parsed = messagePayload.safeParse(safelyReadJson(request));
    if (!origin || !parsed.success)
      return reply.code(400).send({ code: 'INVALID_WEB_CHAT_REQUEST' });
    const supabase = createServiceSupabaseClient();
    if (!supabase) return reply.code(503).send({ code: 'CHAT_NOT_CONFIGURED' });
    const { data, error } = await supabase.rpc('append_web_chat_message', {
      target_body: parsed.data.body,
      target_client_message_id: parsed.data.clientMessageId,
      target_origin: parsed.data.parentOrigin,
      target_rate_scope: rateScope(request, 'message'),
      target_token_hash: tokenHash(parsed.data.token),
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
  });

  app.get('/v1/chat/messages', async (request, reply) => {
    const origin = originHeader(request);
    const parsed = pollQuery.safeParse(request.query);
    if (!origin || !parsed.success)
      return reply.code(400).send({ code: 'INVALID_WEB_CHAT_REQUEST' });
    const supabase = createServiceSupabaseClient();
    if (!supabase) return reply.code(503).send({ code: 'CHAT_NOT_CONFIGURED' });
    const { data, error } = await supabase.rpc('get_web_chat_messages', {
      target_after: parsed.data.after ?? null,
      target_origin: parsed.data.parentOrigin,
      target_token_hash: tokenHash(parsed.data.token),
    });
    if (error)
      return reply
        .code(error.code === '42501' ? 403 : 400)
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
  });
  done();
};

function safelyReadJson(request: FastifyRequest): unknown {
  try {
    return bodyAsJson(request);
  } catch {
    return null;
  }
}
