import { readFile } from 'node:fs/promises';

import { evaluateDeploymentConfig, INTERNAL_API_URL } from '@avenlyo/shared';
import { describe, expect, it } from 'vitest';

/**
 * The deployment contract, asserted against the files that actually deploy.
 *
 * The policy module proves the rules; this proves the shipped configuration obeys them, for both
 * targets, from source rather than from a running host. It is the cheap half of the production
 * proof -- the expensive half (a real `docker compose` render with a Chromium-capable image) stays
 * in CI, where one container job already exists and does not need to be run twice just because a
 * hostname differs.
 *
 * Everything Phase 19 established about the network boundary is re-asserted here, because Phase 20
 * touches the Caddyfile and the compose file and a security property that is only true by accident
 * is not true.
 */

const compose = () => readFile('deploy/compose.yaml', 'utf8');
const caddyfile = () => readFile('deploy/Caddyfile', 'utf8');

/** Configuration lines only. An assertion that matches a file's own prose proves nothing. */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function serviceBlock(text: string, name: 'web' | 'api' | 'caddy'): string {
  const order = ['web', 'api', 'caddy'] as const;
  const start = text.indexOf(`\n  ${name}:`);
  const next = order[order.indexOf(name) + 1];
  return text.slice(start, next ? text.indexOf(`\n  ${next}:`) : undefined);
}

describe('public hostnames are configurable; trusted upstreams are not', () => {
  it('substitutes both public hostnames from the environment', async () => {
    const text = await caddyfile();

    expect(text).toMatch(/\{\$AVENLYO_WEB_HOST:staging\.avenlyo\.com\} \{/);
    expect(text).toMatch(/\{\$AVENLYO_API_HOST:api-staging\.avenlyo\.com\} \{/);
  });

  it('defaults to exactly today’s staging behaviour when nothing is set', async () => {
    // Phase 20 must not change the running deployment. An operator who sets no new variable gets
    // the same two hostnames the staging host is serving right now.
    const text = await caddyfile();

    expect(text).toContain(':staging.avenlyo.com}');
    expect(text).toContain(':api-staging.avenlyo.com}');
  });

  it('keeps every reverse_proxy destination a source-controlled literal', async () => {
    const text = withoutComments(await caddyfile());
    const upstreams = [...text.matchAll(/reverse_proxy\s+(\S+)/g)].map((m) => m[1]);

    // Three upstreams, all literals. If an environment variable could reach this list, a deployment
    // could redirect Caddy -- the one process allowed to talk to the API -- somewhere else.
    expect(upstreams).toEqual(['web:3000', 'api:4000', 'api:4000']);
    for (const upstream of upstreams) {
      expect(upstream).not.toContain('$');
    }
  });

  it('still replaces the forwarding chain on all three routes', async () => {
    const text = await caddyfile();

    expect(text).toContain('header_up X-Forwarded-For {remote_host}');
    expect(text).toContain('header_up X-Real-IP {remote_host}');
    expect(text.match(/import sanitized_forwarding/g)).toHaveLength(3);
  });

  it('keeps the internal listener a literal port with no hostname', async () => {
    const text = withoutComments(await caddyfile());

    expect(text).toMatch(/^:8080 \{/m);
  });
});

describe('the Phase 19 network boundary survives Phase 20', () => {
  it('keeps web and api on separate networks', async () => {
    const text = await compose();

    expect(serviceBlock(text, 'web')).toContain('- web_edge');
    expect(serviceBlock(text, 'web')).not.toContain('- api_edge');
    expect(serviceBlock(text, 'api')).toContain('- api_edge');
    expect(serviceBlock(text, 'api')).not.toContain('- web_edge');
    expect(serviceBlock(text, 'caddy')).toContain('- web_edge');
    expect(serviceBlock(text, 'caddy')).toContain('- api_edge');
  });

  it('publishes host ports from Caddy alone, and never 3000, 4000 or 8080', async () => {
    const text = await compose();

    expect(serviceBlock(text, 'web')).not.toMatch(/^\s{4}ports:/m);
    expect(serviceBlock(text, 'api')).not.toMatch(/^\s{4}ports:/m);

    const caddy = withoutComments(serviceBlock(text, 'caddy'));
    expect(caddy).toMatch(/^\s{4}ports:/m);
    const published = [...caddy.matchAll(/^\s+- "(\d+):/gm)].map((m) => m[1]);
    expect(published.sort()).toEqual(['443', '443', '80']);
    for (const port of ['3000', '4000', '8080']) {
      expect(published).not.toContain(port);
    }
  });

  it('keeps api exposed only on the compose network', async () => {
    const api = serviceBlock(await compose(), 'api');

    expect(api).toContain('expose:');
    expect(api).toContain('"4000"');
  });

  it('keeps every Phase 18/19 container security option', async () => {
    const api = serviceBlock(await compose(), 'api');

    expect(api).toContain('init: true');
    expect(api).toContain('no-new-privileges:true');
    expect(api).toContain('seccomp:./chromium-seccomp.json');
    expect(api).not.toMatch(/cap_add/);
    expect(withoutComments(await compose())).not.toMatch(/SYS_ADMIN/i);
  });

  it('keeps SHA-tagged images and bounded logging', async () => {
    const text = withoutComments(await compose());

    expect(text).toContain('image: avenlyo-web:${AVENLYO_RELEASE:-local}');
    expect(text).toContain('image: avenlyo-api:${AVENLYO_RELEASE:-local}');
    expect(text).not.toMatch(/avenlyo-(web|api):latest/);
    expect(text).toContain('max-size');
    expect(text).toContain('max-file');
  });

  it('does not make either network internal, which would cut provider egress', async () => {
    expect(withoutComments(await compose())).not.toMatch(/internal:\s*true/);
  });
});

describe('deployment profiles render safely for both targets', () => {
  /** Build-time public values, exactly as deploy/env/build.env.example describes them. */
  const stagingProfile = {
    apiCorsOrigin: 'https://staging.avenlyo.com',
    caddyApiHost: 'api-staging.avenlyo.com',
    caddyWebHost: 'staging.avenlyo.com',
    deploymentEnv: 'staging' as const,
    internalApiUrl: INTERNAL_API_URL,
    publicApiUrl: 'https://api-staging.avenlyo.com',
    publicWebUrl: 'https://staging.avenlyo.com',
    release: 'c000caf742f7e4ca5d8dc85376931fcbb7a9e6a7',
    webChatIframeOrigin: 'https://staging.avenlyo.com',
  };

  const productionProfile = {
    ...stagingProfile,
    apiCorsOrigin: 'https://avenlyo.com',
    caddyApiHost: 'api.avenlyo.com',
    caddyWebHost: 'avenlyo.com',
    deploymentEnv: 'production' as const,
    publicApiUrl: 'https://api.avenlyo.com',
    publicWebUrl: 'https://avenlyo.com',
    webChatIframeOrigin: 'https://avenlyo.com',
  };

  const errorsFor = (profile: Parameters<typeof evaluateDeploymentConfig>[0]) =>
    evaluateDeploymentConfig(profile).filter((f) => f.severity === 'error');

  it('accepts the staging profile without production checks misfiring', () => {
    expect(errorsFor(stagingProfile)).toEqual([]);
  });

  it('accepts the production placeholder profile', () => {
    expect(errorsFor(productionProfile)).toEqual([]);
  });

  it('rejects a production profile the moment a staging hostname is injected', () => {
    // The negative case is the one worth having: it proves the guard catches the defect rather than
    // merely existing.
    const injected = { ...productionProfile, publicApiUrl: 'https://api-staging.avenlyo.com' };

    expect(errorsFor(injected).map((f) => f.check)).toContain('no_staging_host_in_production');
  });

  it('rejects a production profile served over plain HTTP', () => {
    const injected = { ...productionProfile, publicWebUrl: 'http://avenlyo.com' };

    expect(errorsFor(injected).map((f) => f.check)).toContain('public_scheme_is_https');
  });

  it('rejects a profile that routes web straight at the API again', () => {
    const injected = { ...productionProfile, internalApiUrl: 'http://api:4000' };

    expect(errorsFor(injected).map((f) => f.check)).toContain('internal_api_boundary');
  });
});
