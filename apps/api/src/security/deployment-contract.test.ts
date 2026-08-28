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
      // Non-secret: a project ref, not a key. It is the EXPECTED half of the Supabase identity
      // comparison; the ACTUAL half stays in api.env as SUPABASE_URL.
      'AVENLYO_PROFILE_EXPECTED_SUPABASE_PROJECT_REF',
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

describe('provenance is read from the compose source, never from the render', () => {
  /**
   * The Phase 21A staging failure, pinned.
   *
   * `docker compose config` resolves `env_file:` into the rendered service `environment:` map. A
   * check that asked the RENDER whether `deploy/compose.yaml` declares a key therefore answered
   * "yes" on any host whose `/etc/avenlyo/api.env` declares it -- which is every correctly
   * configured host, because Phase 20 requires api.env to declare the deployment identity.
   *
   * The gate failed closed on a good deployment. CI missed it because its fixture wrote an empty
   * api.env, so there was nothing to merge and the check passed vacuously.
   */
  const script = () => readFile('.github/scripts/assert-deployment-profile.mjs', 'utf8');

  it('no longer decides provenance from the rendered environment', async () => {
    const source = await script();

    // The exact defective expression must not come back.
    expect(source).not.toMatch(/envOf\(\s*'api'\s*,\s*'AVENLYO_DEPLOYMENT_ENV'\s*\)/);
  });

  it('reads deploy/compose.yaml itself for the provenance checks', async () => {
    const source = await script();

    expect(source).toContain("readFileSync('deploy/compose.yaml', 'utf8')");
    expect(source).toContain('sourceEnvironment');
    // Normalised newlines, or a CRLF checkout leaves a trailing \r on every key and the parser
    // silently matches nothing -- which would make every absence check pass while proving nothing.
    expect(source).toMatch(/replace\(\/\\r\\n\/g, '\\n'\)/);
  });

  it('guards its own source parser against silently matching nothing', async () => {
    const source = await script();

    // An absence assertion over a mis-parsed empty block is not a check. The script asserts the
    // block parsed to a plausible size before trusting any absence conclusion drawn from it.
    expect(source).toMatch(/the api source environment block parsed as/);
    expect(source).toMatch(/the web source environment block parsed as/);
  });

  it('still asserts the two provenance facts the deployment depends on', async () => {
    const source = await script();

    expect(source).toContain("!('AVENLYO_DEPLOYMENT_ENV' in apiSourceEnv)");
    expect(source).toMatch(/AVENLYO_PROFILE_DEPLOYMENT_ENV \?\? ''/);
    expect(source).toMatch(/webSourceEnv\.AVENLYO_API_URL \?\? ''/);
  });

  it('no longer scans the whole render for a staging hostname', async () => {
    // Same defect class: api.env legitimately carries API_CORS_ORIGIN=https://staging.avenlyo.com,
    // so a whole-document scan made the PRODUCTION profile look cross-wired on a real host. The
    // check now reads only the rendered keys Compose fills from the profile.
    const source = await script();

    expect(source).not.toContain('rendered production compose still contains');
    expect(source).toContain('PROFILE_FED_RENDERED_KEYS');
  });

  it('scopes the SYS_ADMIN check so a merged env value cannot trip it', async () => {
    const source = await script();

    expect(source).toContain('withoutComments(composeSource)');
    expect(source).toContain('grantedCapabilities');
  });
});

describe('CI exercises the assertion against the real host shape', () => {
  const workflow = () => readFile('.github/workflows/ci.yml', 'utf8');

  it('writes a non-empty /etc/avenlyo/api.env in the deployment contract job', async () => {
    const text = await workflow();

    // The empty fixture is what hid the defect for a release.
    expect(text).not.toMatch(/sudo touch \/etc\/avenlyo\/web\.env \/etc\/avenlyo\/api\.env/);
    expect(text).toContain('AVENLYO_DEPLOYMENT_ENV=staging');
    expect(text).toContain('WEB_CHAT_IFRAME_ORIGIN=https://staging.avenlyo.com');
  });

  it('fails if the fixture stops reproducing env_file merging', async () => {
    // A fixture that no longer merges would make every provenance guard vacuous again, silently.
    const text = await workflow();

    expect(text).toContain('Prove the fixture reproduces env_file merging');
    expect(text).toMatch(/env_file did not merge into the render/);
  });

  it('injects each provenance defect and requires rejection', async () => {
    const text = await workflow();

    expect(text).toContain('The profile must not override the api runtime deployment identity');
    expect(text).toContain('The profile identity mirror must exist and come from the profile');
    expect(text).toContain('A hardcoded Caddy hostname must fail the production profile');
    expect(text).toContain('Web AVENLYO_API_URL must come from the profile, not a literal');
  });
});

describe('the host-side validation command needs no Node runtime', () => {
  const runbook = () => readFile('docs/production-runbook.md', 'utf8');
  const hetzner = () => readFile('docs/deployment/hetzner-staging.md', 'utf8');

  /**
   * The staging host builds everything in Docker and has no Node installed, so a documented host
   * step of `node .github/scripts/...` was not executable there. The source/topology assertion is a
   * CI gate; the host gate is the Compose one, which needs only what the host already runs.
   */
  it('documents `config --quiet` as the host step', async () => {
    const text = await runbook();

    expect(text).toContain('-f deploy/compose.yaml config --quiet');
  });

  it('does not tell an operator to run the Node assertion on the host', async () => {
    const text = await runbook();
    const order = text.slice(text.indexOf('## Deployment order'), text.indexOf('## Rollback'));

    expect(order).not.toMatch(/^\s*node \.github\/scripts\/assert-deployment-profile\.mjs/m);
    // Whitespace-normalised: the sentence wraps across lines, and a CRLF checkout would otherwise
    // make this assertion depend on the line ending rather than on the prose.
    expect(order.replace(/\s+/g, ' ')).toContain('not on the deployment host');
  });

  it('says plainly that the deployment host has no Node runtime', async () => {
    expect(await hetzner()).toContain('There is no Node runtime');
  });

  it('CI proves the documented host command, including that it stays silent', async () => {
    const text = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(text).toContain('Documented host-side validation command (no Node runtime required)');
    expect(text).toContain('config --quiet printed output');
    expect(text).toContain('The documented host command must reject a broken profile');
  });
});

describe('the documented operator path never renders secrets', () => {
  const runbook = () => readFile('docs/production-runbook.md', 'utf8');

  /**
   * `docker compose config` merges env_file contents, so on a real host it prints the service-role
   * key and every provider credential as ordinary YAML. The documented path must never do that.
   */
  it('warns that a plain config render prints secrets', async () => {
    const text = await runbook();

    expect(text).toContain('Never render the full compose config');
    expect(text).toMatch(/UNSAFE on a real host/);
  });

  it('shows key-presence checks instead of printing env files', async () => {
    const text = await runbook();

    expect(text).toContain("grep -c '^AVENLYO_API_URL=' /etc/avenlyo/web.env");
    expect(text).toMatch(/Never.{0,20}`cat`/s);
  });

  it('every documented `docker compose ... config` invocation is quiet or redirected', async () => {
    // The one deliberate exception is the UNSAFE example, which exists to be labelled unsafe.
    const text = await runbook();
    const lines = text.split('\n');

    let seen = 0;
    lines.forEach((line, index) => {
      if (!/^\s*docker compose .*\bconfig\b/.test(line)) return;
      seen += 1;
      // The one deliberate exception is the worked example that exists to be labelled unsafe; its
      // marker sits on the preceding comment line, the way it reads inside the code block.
      const labelledUnsafe = /#\s*UNSAFE/.test(lines[index - 1] ?? '');
      const safe = line.includes('--quiet') || line.includes('>') || labelledUnsafe;
      expect(safe, `unguarded config render: ${line.trim()}`).toBe(true);
    });
    expect(seen).toBeGreaterThan(0);
  });

  it('the assertion script never prints its own render', async () => {
    const source = await readFile('.github/scripts/assert-deployment-profile.mjs', 'utf8');
    // The render holds every value merged from /etc/avenlyo/api.env on a real host, so it must
    // never reach an output stream -- neither passed directly nor interpolated into a message.
    expect(source).toContain('let rendered;');
    expect(source).not.toMatch(/write\(\s*rendered/);
    expect(source).not.toMatch(/\$\{rendered/);
    expect(source).not.toMatch(/console\.(log|error|warn)/);
  });
});

describe('the host migration off the pre-Phase-20 env layout is documented', () => {
  const runbook = () => readFile('docs/production-runbook.md', 'utf8');

  it('documents both one-time env-file edits as key-level, secret-safe operations', async () => {
    const text = await runbook();

    expect(text).toContain('Migrating a host off the pre-Phase-20 env layout');
    expect(text).toContain("grep -c '^AVENLYO_DEPLOYMENT_ENV=' /etc/avenlyo/api.env");
    expect(text).toContain("sed '/^AVENLYO_API_URL=/d' /etc/avenlyo/web.env");
    // Verification is by silent comparison, not by diffing two secret-bearing files. The previous
    // wording asked for a diff that "must show exactly one removed line" -- which is exactly the
    // disclosure this now forbids: an unintended second change would have printed a secret.
    // Verification is the shipped verifier, whose exit code is executed in
    // env-migration-verification.test.ts rather than merely described here.
    expect(text).toContain('deploy/scripts/verify-env-migration.sh');
    expect(text).toContain('verified: only the AVENLYO_API_URL assignment changed');
    expect(text).not.toContain('must show exactly one removed line');
    // The fail-open shape must never come back.
    expect(text).not.toContain('|| echo "REFUSED');
  });

  it('keeps the source contract that made the host key obsolete', async () => {
    // Unchanged by this hotfix, re-pinned because the migration doc depends on it being true.
    const webExample = await readFile('deploy/env/web.env.example', 'utf8');
    const compose = await readFile('deploy/compose.yaml', 'utf8');

    expect(webExample).not.toMatch(/^AVENLYO_API_URL=/m);
    expect(compose).toMatch(/AVENLYO_API_URL: \$\{AVENLYO_API_URL:\?/);
  });
});

describe('fetching the authoritative release is executable on the real host', () => {
  it('documents an explicit fetch rather than relying on origin/main', async () => {
    // The staging host's remote.origin.fetch is narrowed to an old infra branch, so origin/main is
    // never updated and `git pull` would deploy nothing new while appearing to succeed.
    const runbook = await readFile('docs/production-runbook.md', 'utf8');

    expect(runbook).toContain('git fetch origin main');
    expect(runbook).toContain('git checkout --detach');
    expect(runbook).toContain('narrowed `remote.origin.fetch`');
  });

  it('records the narrow refspec as known host debt', async () => {
    const hetzner = await readFile('docs/deployment/hetzner-staging.md', 'utf8');

    expect(hetzner).toContain('`remote.origin.fetch` is narrowed');
    expect(hetzner).toContain('operational debt');
  });
});

describe('the documented deployment order needs only git, Docker and Compose', () => {
  /**
   * The Hetzner staging host has no Node runtime and no pnpm; it builds everything inside Docker.
   * A documented step an operator cannot run is not a procedure, so the whole deployment order has
   * to be executable with what the host actually has. Step 3 was fixed first; steps 10 and 11 still
   * said `pnpm smoke:production` and `pnpm ops:status`, which left the sequence non-executable.
   */
  const runbook = () => readFile('docs/production-runbook.md', 'utf8');

  /** The numbered deployment order only -- prose elsewhere may legitimately mention local tooling. */
  const deploymentOrder = async () => {
    const text = (await runbook()).replace(/\r\n/g, '\n');
    return text.slice(text.indexOf('## Deployment order'), text.indexOf('## Rollback'));
  };

  it('contains no pnpm or bare node command', async () => {
    const order = await deploymentOrder();

    expect(order).not.toMatch(/^\s*pnpm\s/m);
    expect(order).not.toMatch(/^\s*node\s/m);
  });

  it('runs the post-deploy smoke from the release image, not from the host', async () => {
    const order = await deploymentOrder();

    expect(order).toContain('run --rm --no-deps -T api node dist/scripts/smoke-production.js');
  });

  it('runs ops-status inside the running container, not from the host', async () => {
    const order = await deploymentOrder();

    expect(order).toContain('exec -T api node dist/scripts/ops-status.js');
  });

  it('explains why the smoke uses run and ops-status uses exec', async () => {
    // The distinction is load-bearing, not stylistic: under `exec` the post-deploy release check
    // would compare a process against itself and could never fail.
    const order = (await deploymentOrder()).replace(/\s+/g, ' ');

    expect(order).toContain('`run`, not `exec`, and that is load-bearing');
    expect(order).toContain('`exec`, not `run`');
    expect(order).toContain('could never fail');
  });

  it('states the host toolchain requirement explicitly', async () => {
    const order = (await deploymentOrder()).replace(/\s+/g, ' ');

    expect(order).toContain('needs only `git`, Docker and Docker Compose on the host');
    expect(order).toContain('local development');
  });

  it('every command in the order is git or docker', async () => {
    const order = await deploymentOrder();
    const commands = [...order.matchAll(/^ {3,}([a-z][a-z-]*)\s/gm)]
      .map((match) => match[1] ?? '')
      .filter((word) => ['pnpm', 'node', 'npm', 'npx', 'yarn', 'tsx'].includes(word));

    expect(commands).toEqual([]);
  });

  it('the checklist no longer asks for a host pnpm command', async () => {
    const text = (await runbook()).replace(/\r\n/g, '\n');
    const checklist = text.slice(text.indexOf('## Deployment checklist'));

    expect(checklist).not.toContain('pnpm smoke:production');
    expect(checklist).not.toContain('pnpm ops:status');
  });
});

describe('every documented operator command ships in the production artifact', () => {
  it('bundles all four operator entry points', async () => {
    // smoke-production was the one that was not: its package script ran the source through tsx,
    // which the production image does not ship, so the documented post-deploy check could not run
    // where it was documented to run.
    const config = await readFile('apps/api/esbuild.config.mjs', 'utf8');

    for (const entry of ['ops-status', 'ops-preflight', 'smoke-production', 'chromium-sandbox-smoke']) {
      expect(config).toContain(`'scripts/${entry}'`);
    }
  });

  it('points the package script at the bundle, keeping tsx for local development only', async () => {
    const pkg = JSON.parse(await readFile('apps/api/package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['smoke:production']).toBe('node dist/scripts/smoke-production.js');
    expect(pkg.scripts['smoke:production:dev']).toContain('tsx');
    expect(pkg.scripts['smoke:smoke-production']).toContain('smoke-production-artifact-smoke.mjs');
  });

  it('CI requires each entry point to exist in the built artifact', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('test -f apps/api/dist/scripts/smoke-production.js');
    expect(workflow).toContain('test -f apps/api/dist/scripts/ops-preflight.js');
    expect(workflow).toContain('pnpm --filter @avenlyo/api smoke:smoke-production');
  });

  it('CI proves both container invocations against the real running deployment', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('ops-status runs inside the running api container (no host Node)');
    expect(workflow).toContain('smoke-production runs from the exact release image (no host Node)');
    // And that the release assertion can actually fail, or it is decoration.
    expect(workflow).toContain('smoke-production rejects a deployment serving a different release');
    expect(workflow).toContain('FAIL  api_release');
  });
});

describe('env-file migration is verified without printing any value', () => {
  /**
   * A full `diff` of two secret-bearing env files is not a verification, it is a disclosure: if an
   * unintended second change slipped in, diff prints the changed secret to the terminal, the
   * scrollback, and whatever it gets pasted into.
   */
  const runbook = async () => (await readFile('docs/production-runbook.md', 'utf8')).replace(/\r\n/g, '\n');

  it('never diffs a secret-bearing env file', async () => {
    const text = await runbook();
    const diffs = [...text.matchAll(/^\s*(sudo )?diff .*$/gm)].map((match) => match[0]);

    for (const line of diffs) {
      expect(line, `documented diff over an env file: ${line.trim()}`).not.toMatch(
        /\/etc\/avenlyo\/|\.env/,
      );
    }
  });

  it('compares filtered copies silently, in the shipped verifier', async () => {
    // The comparison moved out of the runbook and into deploy/scripts/verify-env-migration.sh, so
    // that the documented behaviour and the verified behaviour are the same code. The runbook
    // invokes it; the script performs the filtered, silent comparison.
    const script = await readFile('deploy/scripts/verify-env-migration.sh', 'utf8');

    expect(script).toContain('cmp -s');
    expect(script).toContain('grep -v "^${key}=" "$backup"');
    expect(script).toContain('grep -v "^${key}=" "$live"');
    expect(await runbook()).toContain('deploy/scripts/verify-env-migration.sh');
  });

  it('proves the key count moved exactly 1 -> 0', async () => {
    // Expressed as the verifier's own arguments now: <expected-before> <expected-after>.
    const text = (await runbook()).replace(/\\\n\s*/g, '').replace(/[ \t]+/g, ' ');

    expect(text).toContain('/etc/avenlyo/web.env AVENLYO_API_URL 1 0');

    const script = await readFile('deploy/scripts/verify-env-migration.sh', 'utf8');
    expect(script).toContain('"$before" != "$expected_before"');
    expect(script).toContain('"$after" != "$expected_after"');
  });

  it('creates the backup directory first, 0700, with 0600 backup files', async () => {
    // Runnable from a fresh shell, and the backup of a 0640 secret-bearing file must not inherit
    // that looser mode.
    const text = await runbook();

    expect(text).toContain('mkdir -p "$BK" && chmod 700 "$BK"');
    expect(text).toContain('install -m 600 /dev/null "$BK/web.env.bak"');
    expect(text).toContain('install -m 600 /dev/null "$BK/api.env.bak"');
  });

  it('installs back with the target owner, group and mode', async () => {
    const text = await runbook();

    expect(
      (text.match(/sudo install -o avenlyo -g avenlyo -m 640 "\$T" \/etc\/avenlyo\//g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('says to retain the backups for rollback', async () => {
    const text = (await runbook()).replace(/\s+/g, ' ');

    expect(text).toContain('Keep both backups until the deployment is verified');
    expect(text).toContain('they are the rollback for a configuration mistake');
  });

  it('the api.env identity migration is documented to the same standard', async () => {
    const text = await runbook();

    expect(text).toContain('### Adding the deployment identity to api.env');
    // Same verifier, same guarantees, expressed as its arguments: 0 assignments before, 1 after.
    expect(text.replace(/\\\n\s*/g, '').replace(/[ \t]+/g, ' ')).toContain(
      '/etc/avenlyo/api.env AVENLYO_DEPLOYMENT_ENV 0 1',
    );
  });

  it('never cats an env file anywhere in the runbook', async () => {
    const text = await runbook();
    // `sudo cat FILE > backup` is a redirect into a 0600 file, not a display; a bare cat is not.
    const displays = [...text.matchAll(/^\s*(sudo )?cat [^\n]*\/etc\/avenlyo\/[^\n]*$/gm)]
      .map((match) => match[0])
      .filter((line) => !line.includes('>'));

    expect(displays).toEqual([]);
  });
});

describe('the expected Supabase project ref is a profile declaration, mirrored in', () => {
  /**
   * Provenance, not just presence. The profile declares which project this deployment is FOR;
   * /etc/avenlyo/api.env declares which project it is POINTED AT. Preflight compares them, which is
   * only meaningful while they come from different files.
   */
  it('compose mirrors the profile value under a distinct name', async () => {
    const api = serviceBlock(withoutComments(await compose()), 'api');

    expect(api).toMatch(
      /AVENLYO_PROFILE_EXPECTED_SUPABASE_PROJECT_REF: \$\{AVENLYO_EXPECTED_SUPABASE_PROJECT_REF:-\}/,
    );
  });

  it('compose never supplies the runtime name from the profile', async () => {
    // That would put the expectation back into the same precedence chain as api.env and recreate
    // the single-authority problem this change exists to remove.
    const api = serviceBlock(withoutComments(await compose()), 'api');

    expect(api).not.toMatch(/^ {6}AVENLYO_EXPECTED_SUPABASE_PROJECT_REF:/m);
  });

  it('the API reads the profile name, and no longer the runtime name', async () => {
    const env = await readFile('apps/api/src/env.ts', 'utf8');
    const preflight = await readFile('apps/api/src/scripts/ops-preflight.ts', 'utf8');

    expect(env).toContain('AVENLYO_PROFILE_EXPECTED_SUPABASE_PROJECT_REF: emptyAsAbsent(');
    expect(env).not.toMatch(/^ {4}AVENLYO_EXPECTED_SUPABASE_PROJECT_REF:/m);
    expect(preflight).toContain(
      'expectedSupabaseProjectRef: env.AVENLYO_PROFILE_EXPECTED_SUPABASE_PROJECT_REF',
    );
    expect(preflight).not.toContain('env.AVENLYO_EXPECTED_SUPABASE_PROJECT_REF');
  });

  it('the ACTUAL identity still comes only from api.env', async () => {
    // SUPABASE_URL must not migrate into the public profile: it is the value being checked, and it
    // belongs with the credentials that reach the same project.
    const preflight = await readFile('apps/api/src/scripts/ops-preflight.ts', 'utf8');
    expect(preflight).toContain('supabaseUrl: env.SUPABASE_URL');

    for (const target of ['staging', 'production'] as const) {
      const template = await readFile(`deploy/env/${target}.public.env.example`, 'utf8');
      const assignments = template
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#') && line.includes('='))
        .map((line) => line.slice(0, line.indexOf('=')).trim());

      expect(assignments).not.toContain('SUPABASE_URL');
      expect(assignments).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(assignments).not.toContain('SUPABASE_ANON_KEY');
      expect(assignments).toContain('AVENLYO_EXPECTED_SUPABASE_PROJECT_REF');
    }
  });

  it('api.env.example no longer offers the key as an operator authority', async () => {
    const template = await readFile('deploy/env/api.env.example', 'utf8');
    const assignments = template
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#') && line.includes('='))
      .map((line) => line.slice(0, line.indexOf('=')).trim());

    expect(assignments).not.toContain('AVENLYO_EXPECTED_SUPABASE_PROJECT_REF');
    // Still documented, as an explicit "do not set this here" with the reason.
    expect(template).toContain('IS NOT SET HERE');
    expect(template).toContain('SUPABASE_URL');
  });

  it('both public templates state the provenance split explicitly', async () => {
    for (const target of ['staging', 'production'] as const) {
      const template = await readFile(`deploy/env/${target}.public.env.example`, 'utf8');

      expect(template).toContain('SOLE AUTHORITY FOR THE **EXPECTED** PROJECT REF');
      expect(template).toContain('ACTUAL   identity -> SUPABASE_URL in /etc/avenlyo/api.env');
      expect(template).toContain('AVENLYO_PROFILE_EXPECTED_SUPABASE_PROJECT_REF');
    }
  });

  it('the CI assertion proves the mirror at source and in the render', async () => {
    const script = await readFile('.github/scripts/assert-deployment-profile.mjs', 'utf8');

    expect(script).toContain('apiSourceEnv.AVENLYO_PROFILE_EXPECTED_SUPABASE_PROJECT_REF');
    expect(script).toContain("!('AVENLYO_EXPECTED_SUPABASE_PROJECT_REF' in apiSourceEnv)");
    expect(script).toContain("envOf('api', 'AVENLYO_PROFILE_EXPECTED_SUPABASE_PROJECT_REF')");
  });

  it('the profile key set is unchanged in shape: both templates still agree', async () => {
    const keysOf = async (target: string) =>
      [
        ...new Set(
          (await readFile(`deploy/env/${target}.public.env.example`, 'utf8'))
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('#') && line.includes('='))
            .map((line) => line.slice(0, line.indexOf('=')).trim()),
        ),
      ].sort();

    expect(await keysOf('staging')).toEqual(await keysOf('production'));
  });

  it('adds no migration', async () => {
    // This hotfix is configuration wiring only; the schema contract stays where Phase 19 left it.
    const readiness = await readFile('apps/api/src/observability/readiness.ts', 'utf8');

    expect(readiness).toMatch(/REQUIRED_SCHEMA_VERSION\s*=\s*19/);
  });
});
