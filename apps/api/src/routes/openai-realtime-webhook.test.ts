import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  openAIRealtimeWebhookRoutes,
  type OpenAIWebhookVerifier,
} from './openai-realtime-webhook.js';
import type { VoiceRuntime } from '../services/voice/runtime.js';

const incomingEvent = {
  created_at: 1,
  data: {
    call_id: 'rtc_123',
    sip_headers: [{ name: 'Diversion', value: '<sip:+14155550123@twilio.example>' }],
  },
  id: 'evt_123',
  type: 'realtime.call.incoming',
};

async function createApp(
  verify: OpenAIWebhookVerifier['verify'],
  handleIncoming = vi.fn().mockResolvedValue('accepted'),
) {
  const app = Fastify();
  const runtime: VoiceRuntime = {
    inbound: { handleIncoming },
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
  await app.register(openAIRealtimeWebhookRoutes, { runtime, verifier: { verify } });
  return { app, handleIncoming };
}

describe('OpenAI Realtime webhook route', () => {
  const apps: Array<Awaited<ReturnType<typeof createApp>>['app']> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('verifies raw bodies before it parses or invokes inbound call routing', async () => {
    const verify = vi.fn().mockResolvedValue(undefined);
    const { app, handleIncoming } = await createApp(verify);
    apps.push(app);
    const raw = JSON.stringify(incomingEvent);

    const response = await app.inject({
      headers: { 'content-type': 'application/json', 'webhook-id': 'wh_1' },
      method: 'POST',
      payload: raw,
      url: '/webhooks/openai/realtime',
    });
    expect(response.statusCode).toBe(204);
    expect(verify).toHaveBeenCalledWith(raw, expect.objectContaining({ 'webhook-id': 'wh_1' }));
    expect(handleIncoming).toHaveBeenCalledWith(incomingEvent);
  });

  it('rejects a bad or missing signature without parsing into a call action', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('bad signature'));
    const { app, handleIncoming } = await createApp(verify);
    apps.push(app);

    const response = await app.inject({
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      payload: JSON.stringify(incomingEvent),
      url: '/webhooks/openai/realtime',
    });
    expect(response.statusCode).toBe(401);
    expect(handleIncoming).not.toHaveBeenCalled();
  });

  it('acknowledges unrelated verified events and rejects malformed incoming events', async () => {
    const verify = vi.fn().mockResolvedValue(undefined);
    const { app, handleIncoming } = await createApp(verify);
    apps.push(app);
    const ignored = await app.inject({
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      payload: JSON.stringify({ type: 'response.completed' }),
      url: '/webhooks/openai/realtime',
    });
    const malformed = await app.inject({
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      payload: JSON.stringify({ type: 'realtime.call.incoming' }),
      url: '/webhooks/openai/realtime',
    });
    expect(ignored.statusCode).toBe(204);
    expect(malformed.statusCode).toBe(400);
    expect(handleIncoming).not.toHaveBeenCalled();
  });
});
