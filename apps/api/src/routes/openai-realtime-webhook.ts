import OpenAI from 'openai';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { incomingRealtimeCallEventSchema } from '@avenlyo/voice';

import { env } from '../env.js';
import { createVoiceRuntime, type VoiceRuntime } from '../services/voice/runtime.js';

interface OpenAIWebhookVerifier {
  verify(
    rawBody: string,
    headers: Record<string, string | readonly string[] | undefined>,
  ): Promise<void>;
}

class OfficialOpenAIWebhookVerifier implements OpenAIWebhookVerifier {
  private readonly client: OpenAI;

  public constructor(private readonly secret: string) {
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY ?? '' });
  }

  public async verify(
    rawBody: string,
    headers: Record<string, string | readonly string[] | undefined>,
  ): Promise<void> {
    await this.client.webhooks.verifySignature(rawBody, headers, this.secret);
  }
}

export interface OpenAIRealtimeWebhookRouteOptions {
  readonly runtime?: VoiceRuntime | null;
  readonly verifier?: OpenAIWebhookVerifier;
}

const envelopeSchema = z.object({ type: z.string().min(1) }).passthrough();

function rawRequestBody(request: FastifyRequest): string | null {
  return Buffer.isBuffer(request.body) ? request.body.toString('utf8') : null;
}

function headerRecord(
  request: FastifyRequest,
): Record<string, string | readonly string[] | undefined> {
  return request.headers;
}

/** Public, raw-body endpoint. Signature validation deliberately happens before JSON parsing. */
export const openAIRealtimeWebhookRoutes: FastifyPluginAsync<OpenAIRealtimeWebhookRouteOptions> = (
  app,
  options,
) => {
  const runtime = options.runtime ?? createVoiceRuntime();
  const verifier =
    options.verifier ??
    (env.OPENAI_WEBHOOK_SECRET
      ? new OfficialOpenAIWebhookVerifier(env.OPENAI_WEBHOOK_SECRET)
      : null);

  app.addHook('onClose', async () => {
    await runtime?.shutdown();
  });

  app.post('/webhooks/openai/realtime', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const rawBody = rawRequestBody(request);
    if (!runtime || !verifier) {
      return reply.code(503).send({ code: 'VOICE_NOT_CONFIGURED' });
    }
    if (!rawBody) return reply.code(400).send({ code: 'INVALID_WEBHOOK_BODY' });
    try {
      await verifier.verify(rawBody, headerRecord(request));
    } catch {
      return reply.code(401).send({ code: 'INVALID_WEBHOOK_SIGNATURE' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return reply.code(400).send({ code: 'INVALID_WEBHOOK_EVENT' });
    }
    const envelope = envelopeSchema.safeParse(payload);
    if (!envelope.success) return reply.code(400).send({ code: 'INVALID_WEBHOOK_EVENT' });
    if (envelope.data.type !== 'realtime.call.incoming') return reply.code(204).send();
    const event = incomingRealtimeCallEventSchema.safeParse(payload);
    if (!event.success) return reply.code(400).send({ code: 'INVALID_WEBHOOK_EVENT' });
    try {
      await runtime.inbound.handleIncoming(event.data);
    } catch {
      return reply.code(500).send({ code: 'VOICE_CALL_SETUP_FAILED' });
    }
    return reply.code(204).send();
  });
  return Promise.resolve();
};

export type { OpenAIWebhookVerifier };
