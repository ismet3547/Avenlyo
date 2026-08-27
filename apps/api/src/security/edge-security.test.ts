import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

import { buildApp } from '../app.js';

import { canonicalClientAddress, clientRateKey, trustInternalProxy } from './client-identity.js';
import { BODY_LIMITS, EDGE_POLICIES, isUnmeteredRoute, UNMETERED_ROUTES } from './edge-policy.js';

/**
 * The API edge, exercised through real HTTP rather than by asserting configuration.
 *
 * A stated `trustProxy` value proves nothing on its own -- the question is what identity a request
 * actually resolves to when somebody lies to it, and whether a flood is refused before it becomes
 * database work. Everything here goes through `app.inject`, which drives Fastify's real request
 * pipeline including the parser, the limiter and the header plugins.
 */

/** Caddy's address on the compose network. Any private address behaves identically. */
const INTERNAL_HOP = '172.18.0.2';
const REAL_CLIENT = '203.0.113.9';
const OTHER_CLIENT = '198.51.100.4';

/**
 * A minimal app carrying the production trust predicate and nothing else.
 *
 * It answers with the hashed rate key rather than the address, so the assertions prove which client
 * a request resolved to without the test itself handling a raw address any more than production
 * does.
 */
function identityProbe(): FastifyInstance {
  const app = Fastify({ trustProxy: trustInternalProxy });
  app.get('/whoami', (request) => ({ key: clientRateKey(request, 'probe') }));
  return app;
}

function expectedKey(address: string): string {
  return clientRateKey({ ip: address } as never, 'probe');
}

describe('the trusted-proxy boundary decides who the client is', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = identityProbe();
  });

  afterEach(async () => {
    await app.close();
  });

  it('recovers the real public client through the one legitimate Caddy hop', async () => {
    const response = await app.inject({
      headers: { 'x-forwarded-for': REAL_CLIENT },
      method: 'GET',
      remoteAddress: INTERNAL_HOP,
      url: '/whoami',
    });

    expect(response.json()).toEqual({ key: expectedKey(REAL_CLIENT) });
  });

  it('ignores a forwarded header sent by a public peer', async () => {
    // The API is never publicly reachable in the deployed topology, but if it ever were, a caller
    // must not be able to name its own identity. The peer's own address wins.
    const response = await app.inject({
      headers: { 'x-forwarded-for': OTHER_CLIENT },
      method: 'GET',
      remoteAddress: REAL_CLIENT,
      url: '/whoami',
    });

    expect(response.json()).toEqual({ key: expectedKey(REAL_CLIENT) });
    expect(response.json()).not.toEqual({ key: expectedKey(OTHER_CLIENT) });
  });

  it('takes the hop Caddy appended, not an address the client prepended', async () => {
    // Caddy's own config replaces this header, but if it ever appended instead, the client's
    // injected entry sits to the left of the truth and must still lose.
    const response = await app.inject({
      headers: { 'x-forwarded-for': `${OTHER_CLIENT}, ${REAL_CLIENT}` },
      method: 'GET',
      remoteAddress: INTERNAL_HOP,
      url: '/whoami',
    });

    expect(response.json()).toEqual({ key: expectedKey(REAL_CLIENT) });
  });

  it('cannot be walked back to an internal address by chaining private entries', async () => {
    const response = await app.inject({
      headers: { 'x-forwarded-for': `${REAL_CLIENT}, 10.0.0.9` },
      method: 'GET',
      remoteAddress: INTERNAL_HOP,
      url: '/whoami',
    });

    // 10.0.0.9 is trusted as a hop, so the walk continues and lands on the real client rather than
    // stopping on an address the caller supplied.
    expect(response.json()).toEqual({ key: expectedKey(REAL_CLIENT) });
  });

  it('resolves an IPv6 client to its /64', async () => {
    const response = await app.inject({
      headers: { 'x-forwarded-for': '2001:db8:1:2:3:4:5:6' },
      method: 'GET',
      remoteAddress: INTERNAL_HOP,
      url: '/whoami',
    });

    expect(response.json()).toEqual({ key: expectedKey('2001:db8:1:2::') });
    expect(canonicalClientAddress('2001:db8:1:2:3:4:5:6')).toBe('2001:0db8:0001:0002::/64');
  });

  it('fails safely on a malformed chain instead of adopting it', async () => {
    const response = await app.inject({
      headers: { 'x-forwarded-for': 'not-an-address, ,,, %%%' },
      method: 'GET',
      remoteAddress: INTERNAL_HOP,
      url: '/whoami',
    });

    expect(response.statusCode).toBe(200);
    // Nothing in the chain parsed, so the identity is the fixed unresolved bucket, never the junk.
    expect(response.json()).toEqual({ key: clientRateKey({ ip: 'nonsense' } as never, 'probe') });
  });
});

describe('the API is not published to the host', () => {
  it('exposes 4000 on the compose network only', async () => {
    const { readFile } = await import('node:fs/promises');
    const compose = await readFile('deploy/compose.yaml', 'utf8');
    const apiBlock = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  caddy:'));

    expect(apiBlock).toContain('expose:');
    expect(apiBlock).toContain('"4000"');
    // A `ports:` mapping here would publish the API straight to the internet and make every
    // forwarding-header protection above bypassable by connecting directly.
    expect(apiBlock).not.toMatch(/^\s{4}ports:/m);
  });

  it('publishes host ports from Caddy alone', async () => {
    const { readFile } = await import('node:fs/promises');
    const compose = await readFile('deploy/compose.yaml', 'utf8');
    const webBlock = compose.slice(compose.indexOf('\n  web:'), compose.indexOf('\n  api:'));

    expect(webBlock).not.toMatch(/^\s{4}ports:/m);
    expect(compose.slice(compose.indexOf('\n  caddy:'))).toMatch(/^\s{4}ports:/m);
  });

  it('has Caddy replace the forwarding chain rather than append to it', async () => {
    const { readFile } = await import('node:fs/promises');
    const caddyfile = await readFile('deploy/Caddyfile', 'utf8');

    expect(caddyfile).toContain('header_up X-Forwarded-For {remote_host}');
    expect(caddyfile).toContain('header_up X-Real-IP {remote_host}');
  });
});

describe('edge rate limits refuse a flood before it becomes work', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  /** Sequential on purpose: a quota is a property of ordered requests, not concurrent ones. */
  async function hit(
    count: number,
    client: string,
    url: string,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<LightMyRequestResponse[]> {
    const responses: LightMyRequestResponse[] = [];
    for (let index = 0; index < count; index += 1) {
      const options: InjectOptions = {
        headers: { origin: 'http://localhost:3000', 'x-forwarded-for': client },
        method,
        remoteAddress: INTERNAL_HOP,
        url,
        ...(method === 'POST' ? { payload: {} } : {}),
      };
      const response = await app.inject(options);
      responses.push(response);
    }
    return responses;
  }

  it('trips the web-chat session policy and answers a bounded 429', async () => {
    const responses = await hit(
      EDGE_POLICIES.webChatSession.max + 1,
      REAL_CLIENT,
      '/v1/chat/session',
    );
    const limited = responses.at(-1);

    expect(limited?.statusCode).toBe(429);
    expect(limited?.json()).toEqual({
      code: 'RATE_LIMITED',
      request_id: expect.any(String),
      statusCode: 429,
    });
    // Bounded: a fixed shape with no address, token, or limiter internals in it.
    expect(JSON.stringify(limited?.json())).not.toContain(REAL_CLIENT);
    expect(limited?.headers['retry-after']).toBeDefined();
    expect(limited?.headers['x-request-id']).toBeDefined();
  });

  it('trips the web-chat message policy', async () => {
    const responses = await hit(
      EDGE_POLICIES.webChatMessage.max + 1,
      REAL_CLIENT,
      '/v1/chat/messages',
    );

    expect(responses.at(-1)?.statusCode).toBe(429);
  });

  it('trips the polling policy', async () => {
    const responses = await hit(
      EDGE_POLICIES.webChatPoll.max + 1,
      REAL_CLIENT,
      '/v1/chat/messages',
      'GET',
    );

    expect(responses.at(-1)?.statusCode).toBe(429);
  });

  it('does not let one client spend another client’s quota', async () => {
    await hit(EDGE_POLICIES.webChatSession.max + 1, REAL_CLIENT, '/v1/chat/session');
    const other = await hit(1, OTHER_CLIENT, '/v1/chat/session');

    expect(other[0]?.statusCode).not.toBe(429);
  });

  it('cannot be evaded by rotating the forwarded header from a public peer', async () => {
    // Every request genuinely comes from REAL_CLIENT; only the header it writes changes. Because a
    // public peer is never a trusted hop, the header is ignored and all of them share one bucket.
    const responses: LightMyRequestResponse[] = [];
    for (let index = 0; index <= EDGE_POLICIES.webChatSession.max; index += 1) {
      const response = await app.inject({
        headers: {
          origin: 'http://localhost:3000',
          'x-forwarded-for': `10.9.9.${index % 250}`,
        },
        method: 'POST',
        payload: {},
        remoteAddress: REAL_CLIENT,
        url: '/v1/chat/session',
      });
      responses.push(response);
    }

    expect(responses.at(-1)?.statusCode).toBe(429);
  });

  it('never rate-limits an infrastructure health probe', async () => {
    // Docker treats a non-200 healthcheck as a dead container, so public abuse traffic must not be
    // able to make a healthy process look dead.
    const responses = await hit(EDGE_POLICIES.global.max + 5, REAL_CLIENT, '/health/live', 'GET');

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
  });

  it('exempts provider webhook routes deliberately, and says so in one place', () => {
    for (const route of [
      '/webhooks/stripe',
      '/webhooks/openai/realtime',
      '/v1/webhooks/twilio/messaging/inbound',
      '/v1/webhooks/twilio/messaging/status',
    ]) {
      expect(isUnmeteredRoute(route)).toBe(true);
    }
    expect(isUnmeteredRoute('/v1/chat/session')).toBe(false);
    expect(UNMETERED_ROUTES).toContain('/health/ready');
  });
});

describe('request size is bounded before any downstream work', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('refuses an oversized web-chat message body', async () => {
    const response = await app.inject({
      headers: { origin: 'http://localhost:3000' },
      method: 'POST',
      payload: { body: 'x'.repeat(BODY_LIMITS.webChatMessage + 1024), clientMessageId: 'x' },
      remoteAddress: INTERNAL_HOP,
      url: '/v1/chat/messages',
    });

    // 413 from the parser, which runs before the handler -- so no Supabase client is constructed
    // and no RPC is attempted for a body this size.
    expect(response.statusCode).toBe(413);
    expect(response.json()).not.toHaveProperty('code', 'WEB_CHAT_MESSAGE_REJECTED');
  });

  it('refuses an oversized Twilio form body', async () => {
    const response = await app.inject({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      payload: `Body=${'x'.repeat(BODY_LIMITS.twilioForm + 1024)}`,
      remoteAddress: INTERNAL_HOP,
      url: '/v1/webhooks/twilio/messaging/inbound',
    });

    expect(response.statusCode).toBe(413);
  });

  it('still accepts a Twilio form of realistic size', async () => {
    // 2,000 characters of message body plus the provider's own fields must keep parsing; the
    // signature check is what rejects it afterwards, not the size policy.
    const response = await app.inject({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      payload: `Body=${'x'.repeat(2000)}&From=%2B15550000000&To=%2B15550000001&MessageSid=SM${'a'.repeat(32)}`,
      remoteAddress: INTERNAL_HOP,
      url: '/v1/webhooks/twilio/messaging/inbound',
    });

    expect(response.statusCode).not.toBe(413);
  });

  it('keeps a global ceiling well under Fastify’s 1 MiB default', () => {
    expect(BODY_LIMITS.global).toBeLessThan(1024 * 1024);
    expect(BODY_LIMITS.webChatMessage).toBeGreaterThan(2000);
  });
});

describe('security headers suit a JSON API rather than an HTML document', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('sets the headers that mean something here', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['permissions-policy']).toContain('camera=()');
    expect(String(response.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('does not set a cross-origin policy that would break the embedded widget', async () => {
    // Helmet's default Cross-Origin-Resource-Policy is same-origin, which would stop the chat
    // iframe reading any of these responses from a customer's site.
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['cross-origin-resource-policy']).toBeUndefined();
    expect(response.headers['cross-origin-embedder-policy']).toBeUndefined();
  });

  it('omits HSTS outside production', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('answers the web-chat preflight with the configured origin only', async () => {
    const response = await app.inject({
      headers: { 'access-control-request-method': 'GET', origin: 'http://localhost:3000' },
      method: 'OPTIONS',
      url: '/v1/chat/messages',
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('never echoes a foreign origin back as allowed', async () => {
    // @fastify/cors answers the preflight before the web-chat OPTIONS handler runs (see the CSP
    // note in the PR): a foreign origin still gets 204, but with the configured origin rather than
    // its own, so the browser refuses the real request. Recording the actual behaviour here rather
    // than the behaviour the dead handler would have produced.
    const response = await app.inject({
      headers: { 'access-control-request-method': 'GET', origin: 'https://somewhere-else.example' },
      method: 'OPTIONS',
      url: '/v1/chat/messages',
    });

    expect(response.headers['access-control-allow-origin']).not.toBe(
      'https://somewhere-else.example',
    );
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('enforces the iframe origin on the real methods, not only at preflight', async () => {
    // The server-side check is what actually protects the route, and it does not depend on the
    // preflight path being reached.
    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({
        headers: {
          origin: 'https://somewhere-else.example',
          'x-avenlyo-chat-token': 'a'.repeat(43),
        },
        method,
        ...(method === 'POST'
          ? { payload: { body: 'hi', clientMessageId: crypto.randomUUID() } }
          : {}),
        remoteAddress: INTERNAL_HOP,
        url: '/v1/chat/messages',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_WEB_CHAT_REQUEST' });
    }
  });

  it('emits an API content-security-policy, not a document one', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const csp = String(response.headers['content-security-policy']);

    expect(csp).toContain("default-src 'none'");
    // Helmet's document defaults would have permitted scripts and inline styles from this surface.
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('style-src');
  });
});
