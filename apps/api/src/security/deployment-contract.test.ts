import { readFile } from 'node:fs/promises';

import {
  DEPLOYED_ENVIRONMENTS,
  evaluateDeploymentConfig,
  INTERNAL_API_URL,
  REQUIRED_DEPLOYED_PROFILE_SETTINGS,
} from '@avenlyo/shared';
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
  /** Public values, exactly as deploy/env/staging.public.env.example declares them. */
  const stagingProfile = {
    apiCorsOrigin: 'https://staging.avenlyo.com',
    caddyApiHost: 'api-staging.avenlyo.com',
    caddyWebHost: 'staging.avenlyo.com',
    deploymentEnv: 'staging' as const,
    internalApiUrl: INTERNAL_API_URL,
    profileDeploymentEnv: 'staging',
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
    profileDeploymentEnv: 'production',
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

describe('the CI profile assertion cannot drift from the shared policy', () => {
  const script = () => readFile('.github/scripts/assert-deployment-profile.mjs', 'utf8');

  /**
   * The assertion script mirrors DEPLOYED_ENVIRONMENTS as a literal, because `@avenlyo/shared`
   * exports raw TypeScript and the script runs under plain `node` in CI -- running the deployment
   * gate through a source loader would make it depend on the toolchain it exists to check.
   *
   * Duplication is acceptable only while it is guarded, which is what this does. If someone adds a
   * deployed environment to the shared policy and not to the script, the script would silently
   * reject a legitimate profile; if they add it only to the script, it would accept one the policy
   * does not recognise. Either way this fails first.
   */
  it('mirrors DEPLOYED_ENVIRONMENTS exactly', async () => {
    const source = await script();
    const declared = /const DEPLOYED_ENVIRONMENTS = \[([^\]]*)\]/.exec(source);

    expect(declared).not.toBeNull();
    const mirrored = [...(declared?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
    expect(mirrored).toEqual([...DEPLOYED_ENVIRONMENTS]);
  });

  it('reads the deployment identity from the profile rather than trusting the caller', async () => {
    const source = await script();

    // The identity must come from the file being validated. If the CLI argument were the authority,
    // a profile could declare staging -- or declare nothing -- and still be checked under
    // production rules because the caller said "production".
    expect(source).toContain('profile.AVENLYO_DEPLOYMENT_ENV');
    expect(source).toMatch(/declared !== expectedTarget/);
  });
});

describe('one deployment-profile contract, shared by the templates, Compose and CI', () => {
  /**
   * The defect this suite exists for: CI used to carry its own hand-written profiles, richer than
   * `deploy/env/build.env.example` -- the template an operator is told to copy. A green deployment
   * contract therefore proved a file no human would ever deploy from. The templates are now the
   * profile, CI generates its fixtures from them, and these assertions are what keep that true.
   */
  const profileTemplate = (target: 'staging' | 'production') =>
    readFile(`deploy/env/${target}.public.env.example`, 'utf8');

  /** Assignments only, so a key mentioned in this file's own prose does not count as declared. */
  function declaredKeys(text: string): Set<string> {
    return new Set(
      text
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#') && line.includes('='))
        .map((line) => line.slice(0, line.indexOf('=')).trim()),
    );
  }

  for (const target of ['staging', 'production'] as const) {
    it(`the source ${target} profile declares every required setting`, async () => {
      const declared = declaredKeys(await profileTemplate(target));

      for (const setting of REQUIRED_DEPLOYED_PROFILE_SETTINGS) {
        expect(declared).toContain(setting);
      }
    });

    it(`the source ${target} profile declares its own identity as ${target}`, async () => {
      expect(await profileTemplate(target)).toContain(`AVENLYO_DEPLOYMENT_ENV=${target}`);
    });

    it(`the source ${target} profile contains no secret-shaped assignment`, async () => {
      // These files are committed, rendered in CI, and printed in terminals. Nothing in them may
      // ever become a credential.
      const text = await profileTemplate(target);

      for (const forbidden of [
        'SUPABASE_SERVICE_ROLE_KEY=',
        'SUPABASE_ANON_KEY=',
        'STRIPE_SECRET_KEY=',
        'STRIPE_WEBHOOK_SECRET=',
        'OPENAI_API_KEY=',
        'TWILIO_AUTH_TOKEN=',
        'GOOGLE_CLIENT_SECRET=',
        'AVENLYO_INTERNAL_BILLING_SECRET=',
      ]) {
        expect(withoutComments(text)).not.toContain(forbidden);
      }
    });
  }

  it('both targets declare exactly the same set of keys', async () => {
    // A value present in one environment and absent from the other is a difference nobody chose,
    // and it is always found in the environment where finding it is expensive.
    const staging = [...declaredKeys(await profileTemplate('staging'))].sort();
    const production = [...declaredKeys(await profileTemplate('production'))].sort();

    expect(staging).toEqual(production);
  });

  it('the internal boundary is identical in both, and is the source-controlled value', async () => {
    for (const target of ['staging', 'production'] as const) {
      expect(await profileTemplate(target)).toContain(`AVENLYO_API_URL=${INTERNAL_API_URL}`);
    }
  });

  it('build.env.example no longer carries a second copy of the profile', async () => {
    // It used to declare its own NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_AVENLYO_API_URL, AVENLYO_WEB_HOST
    // and AVENLYO_API_HOST. That made it a second, independently maintained profile -- the thing
    // that drifted. It now declares only what genuinely cannot be committed.
    const declared = declaredKeys(await readFile('deploy/env/build.env.example', 'utf8'));

    expect([...declared].sort()).toEqual([
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_SUPABASE_URL',
    ]);
  });

  it('web.env.example no longer declares AVENLYO_API_URL', async () => {
    // Two authorities for one setting meant preflight could certify the Caddy boundary while the
    // running web container reached api:4000 directly.
    const declared = declaredKeys(await readFile('deploy/env/web.env.example', 'utf8'));

    expect(declared).not.toContain('AVENLYO_API_URL');
  });

  it('CI assembles its fixtures from the source templates rather than typing them out', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('deploy/env/${target}.public.env.example');
    expect(workflow).toContain('cat deploy/env/staging.public.env.example');
    // And the old hand-written fixture shape must not come back.
    expect(workflow).not.toContain('AVENLYO_WEB_HOST=avenlyo.com');
  });

  it('the CI assertion script mirrors the same required-key list', async () => {
    const source = await readFile('.github/scripts/assert-deployment-profile.mjs', 'utf8');
    const declared = /const REQUIRED_PROFILE_KEYS = \[([^\]]*)\]/.exec(source);

    expect(declared).not.toBeNull();
    const mirrored = [...(declared?.[1] ?? '').matchAll(/'([A-Z0-9_]+)'/g)].map((match) => match[1]);
    expect(mirrored).toEqual([...REQUIRED_DEPLOYED_PROFILE_SETTINGS]);
  });
});

describe('the running containers read the profile that preflight validates', () => {
  it('wires the web service’s runtime AVENLYO_API_URL from the profile', async () => {
    // Not from /etc/avenlyo/web.env. The value preflight checks and the value the container runs
    // with have to be the same value, or preflight certifies something nobody deployed.
    const web = serviceBlock(withoutComments(await compose()), 'web');

    expect(web).toMatch(/AVENLYO_API_URL: \$\{AVENLYO_API_URL:\?/);
  });

  it('mirrors the profile identity to the API under a distinct name', async () => {
    const api = serviceBlock(withoutComments(await compose()), 'api');

    expect(api).toMatch(/AVENLYO_PROFILE_DEPLOYMENT_ENV: \$\{AVENLYO_DEPLOYMENT_ENV:\?/);
  });

  it('never lets the profile overwrite the API’s own runtime deployment identity', async () => {
    // Compose's `environment:` overrides `env_file:`. Listing AVENLYO_DEPLOYMENT_ENV here would let
    // the profile silently replace the identity /etc/avenlyo/api.env supplies -- including with an
    // empty string, which stops the container booting at all.
    const api = serviceBlock(withoutComments(await compose()), 'api');

    expect(api).not.toMatch(/^ {6}AVENLYO_DEPLOYMENT_ENV:/m);
  });

  it('passes no secret into the compose environment to make a check possible', async () => {
    // Scoped to `environment:`, not the whole file: NEXT_PUBLIC_SUPABASE_ANON_KEY legitimately
    // appears under the web service's `build.args`, because Next inlines it at build time. The rule
    // being asserted is that no secret was added to a runtime environment block so that preflight
    // could see something.
    const api = serviceBlock(withoutComments(await compose()), 'api');
    const environment = api.slice(api.indexOf('    environment:'), api.indexOf('    expose:'));

    for (const forbidden of [
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_ANON_KEY',
      'STRIPE_SECRET_KEY',
      'OPENAI_API_KEY',
      'TWILIO_AUTH_TOKEN',
      'GOOGLE_CLIENT_SECRET',
      'AVENLYO_INTERNAL_BILLING_SECRET',
    ]) {
      expect(environment).not.toContain(forbidden);
    }
    // And every value it does carry is one of the declared, non-secret profile settings.
    const passed = [...environment.matchAll(/^ {6}([A-Z0-9_]+):/gm)].map((match) => match[1]);
    expect(passed.sort()).toEqual([
      'AVENLYO_PROFILE_API_HOST',
      'AVENLYO_PROFILE_APP_URL',
      'AVENLYO_PROFILE_DEPLOYMENT_ENV',
      'AVENLYO_PROFILE_PUBLIC_API_URL',
      'AVENLYO_PROFILE_WEB_API_URL',
      'AVENLYO_PROFILE_WEB_HOST',
      'AVENLYO_RELEASE',
    ]);
  });
});

describe('the documented operator preflight command is the one that exists', () => {
  const runbook = () => readFile('docs/production-runbook.md', 'utf8');

  /**
   * The runbook used to say `pnpm ops:preflight` on the host. That was not an executable contract:
   * a host shell receives neither /etc/avenlyo/api.env nor the AVENLYO_PROFILE_* values Compose
   * injects, and a deployment host is not guaranteed to hold a built dist/ at all. The gate that
   * "must exit 0 before anything is applied" was therefore either impossible to run or validating a
   * profile the deployment does not use.
   */
  it('documents the one-off container invocation, not a host pnpm script', async () => {
    const text = await runbook();

    expect(text).toContain('run --rm --no-deps -T api node dist/scripts/ops-preflight.js');
    expect(text).toContain('--env-file deploy/env/build.env');
  });

  it('requires the exact image to exist before the one-off runs', async () => {
    // `docker compose run` has no --no-build flag and builds a missing image. Proving the SHA tag
    // exists first is what makes "this cannot silently build something else" true.
    expect(await runbook()).toMatch(/docker image inspect ["']?avenlyo-api:/);
  });

  it('no longer tells an operator to run pnpm ops:preflight on the host', async () => {
    const text = await runbook();

    expect(text).not.toMatch(/^\s*pnpm ops:preflight\s*$/m);
  });

  it('CI exercises that exact invocation shape', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('run --rm --no-deps -T api node dist/scripts/ops-preflight.js');
    expect(workflow).toContain("docker image inspect -f '{{.Id}}'");
  });
});
