#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Render one deployment profile through the real `docker compose config` and assert the security
 * properties Phase 18 and Phase 19 established, plus the Phase 20 environment isolation rules.
 *
 * The point is that both targets are proven from the SAME compose file and the SAME Caddyfile. If
 * production needed its own stack the two would drift, and the drift would be discovered in
 * production. So the only difference between the profiles this script is handed is public hostname
 * data, and this proves that difference is all there is.
 *
 * Nothing here contacts DNS, ACME, Supabase, Stripe, Twilio, OpenAI, Google or ezyVet. The compose
 * render is local and offline, and every value in the profile is a placeholder.
 *
 * Usage: assert-deployment-profile.mjs <staging|production> <env-file>
 */

/**
 * The deployed environments, mirrored from `DEPLOYED_ENVIRONMENTS` in packages/shared.
 *
 * Duplicated rather than imported because `@avenlyo/shared` exports raw TypeScript, which plain
 * `node` cannot load, and running this CI script through a source loader would make the deployment
 * gate depend on the toolchain it is meant to check. The duplication is guarded instead: a test in
 * apps/api/src/security/deployment-contract.test.ts reads this file and fails if this list and the
 * shared one ever diverge, so it cannot drift silently.
 */
const DEPLOYED_ENVIRONMENTS = ['staging', 'production'];

/**
 * The required deployment-profile keys, mirrored from `REQUIRED_DEPLOYED_PROFILE_SETTINGS` in
 * packages/shared, and guarded by the same drift test as the list above.
 *
 * This is what makes CI and the operator read one contract. The fixtures this script is handed in
 * CI are generated from deploy/env/*.public.env.example rather than typed out in the workflow, so a
 * key CI proves is a key the template an operator is told to copy actually contains.
 */
const REQUIRED_PROFILE_KEYS = [
  'AVENLYO_API_HOST',
  'AVENLYO_API_URL',
  'AVENLYO_DEPLOYMENT_ENV',
  'AVENLYO_WEB_HOST',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_AVENLYO_API_URL',
];

const [, , expectedTarget, envFile] = process.argv;

if (expectedTarget !== 'staging' && expectedTarget !== 'production') {
  process.stderr.write('usage: assert-deployment-profile.mjs <staging|production> <env-file>\n');
  process.exit(2);
}

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const profile = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

// ---------------------------------------------------------------------------------------------
// Deployment identity comes from the PROFILE, not from the command line.
// ---------------------------------------------------------------------------------------------
// The whole Phase 20 premise is that the deployment identity is explicit and part of the deployment
// configuration. If this script took the caller's word for which target it was looking at, a profile
// could declare staging, or declare nothing at all, and still be validated under production rules
// because the CI step happened to say "production" -- the identity would be out-of-band, which is
// the thing being ruled out.
//
// So the profile is the authority. The argument is kept, but only as an assertion about what the
// caller believed: a disagreement means the two sources of truth have drifted and is itself a
// failure, not something to resolve in favour of either side.
const declared = profile.AVENLYO_DEPLOYMENT_ENV;

if (!declared) {
  process.stderr.write(
    `deployment profile "${envFile}" FAILED:\n  - AVENLYO_DEPLOYMENT_ENV is not declared in the ` +
      'profile; a deployed profile must state which deployment it is\n',
  );
  process.exit(1);
}
if (!DEPLOYED_ENVIRONMENTS.includes(declared)) {
  process.stderr.write(
    `deployment profile "${envFile}" FAILED:\n  - AVENLYO_DEPLOYMENT_ENV must be one of ` +
      `${DEPLOYED_ENVIRONMENTS.join(', ')} for a deployed profile\n`,
  );
  process.exit(1);
}
if (declared !== expectedTarget) {
  process.stderr.write(
    `deployment profile "${envFile}" FAILED:\n  - the profile declares a different deployment ` +
      'environment than the caller expected; the identity and the caller have drifted\n',
  );
  process.exit(1);
}

const target = declared;

// Every required key, before the render: an absent key is not a weaker deployment, it is one whose
// contract was never evaluated.
const missing = REQUIRED_PROFILE_KEYS.filter((key) => !(profile[key] ?? '').trim());
if (missing.length > 0) {
  process.stderr.write(
    `deployment profile "${envFile}" FAILED:\n` +
      missing
        .map((key) => `  - ${key} is missing from the deployment profile\n`)
        .join(''),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Render the compose file exactly the way a deploy does.
// ---------------------------------------------------------------------------------------------
let rendered;
try {
  rendered = execFileSync(
    'docker',
    ['compose', '--env-file', envFile, '-f', 'deploy/compose.yaml', 'config'],
    { encoding: 'utf8', env: { ...process.env, ...profile } },
  );
} catch (error) {
  process.stderr.write(`compose config failed: ${error.status ?? error.message}\n`);
  process.exit(1);
}

const caddyfile = readFileSync('deploy/Caddyfile', 'utf8');
const withoutComments = (text) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

const STAGING_HOSTS = ['staging.avenlyo.com', 'api-staging.avenlyo.com'];

// ---------------------------------------------------------------------------------------------
// Phase 20: environment isolation
// ---------------------------------------------------------------------------------------------
if (target === 'production') {
  for (const [name, value] of Object.entries(profile)) {
    for (const host of STAGING_HOSTS) {
      check(!value.includes(host), `production ${name} carries the staging hostname ${host}`);
    }
  }
  for (const key of ['NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_AVENLYO_API_URL']) {
    check(
      (profile[key] ?? '').startsWith('https://'),
      `production ${key} must use https`,
    );
  }
  // The rendered compose must not carry a staging host either -- the Caddy defaults are staging, so
  // this is what proves the profile actually overrode them.
  for (const host of STAGING_HOSTS) {
    check(!rendered.includes(host), `rendered production compose still contains ${host}`);
  }
}

if (target === 'staging') {
  check(rendered.includes('staging.avenlyo.com'), 'staging profile lost its web hostname');
  check(rendered.includes('api-staging.avenlyo.com'), 'staging profile lost its API hostname');
}

// ---------------------------------------------------------------------------------------------
// Phase 18/19: the security boundary, re-proven for whichever profile is being rendered
// ---------------------------------------------------------------------------------------------
// `docker compose config` normalises to alphabetical services, then a top-level `networks:` block.
const serviceBlock = (name) => {
  const order = ['api', 'caddy', 'web'];
  const start = rendered.indexOf(`\n  ${name}:`);
  const next = order[order.indexOf(name) + 1];
  const end = next ? rendered.indexOf(`\n  ${next}:`) : rendered.indexOf('\nnetworks:');
  return rendered.slice(start, end === -1 ? undefined : end);
};

/**
 * The service-level `networks:` mapping, which renders as six-space keys under a four-space header.
 * Read by indentation rather than by substring: the top-level `networks:` block names every network
 * in the project, so a looser match would report each service as attached to all of them.
 */
const networksOf = (name) => {
  const lines = serviceBlock(name).split('\n');
  const header = lines.indexOf('    networks:');
  if (header === -1) return [];
  const attached = [];
  for (const line of lines.slice(header + 1)) {
    if (!line.startsWith('      ')) break;
    attached.push(line.trim().split(':')[0]);
  }
  return attached.sort();
};

// Phase 19's boundary: web and api share no network, so the only path from web to api is through
// Caddy's internal :8080 listener -- which is what keeps the API's trusted-proxy hop count at one.
check(networksOf('web').join() === 'web_edge', 'web must be attached to web_edge only');
check(networksOf('api').join() === 'api_edge', 'api must be attached to api_edge only');
check(networksOf('caddy').join() === 'api_edge,web_edge', 'caddy must bridge both networks');

/** One `environment:` entry of a rendered service, or null. */
const envOf = (service, key) => {
  const match = serviceBlock(service).match(new RegExp(`^      ${key}: (.*)$`, 'm'));
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
};

// The profile is the single authority for the values it declares. These two assertions are what
// make that literally true of the running containers rather than only of the preflight's opinion:
// the web container's own AVENLYO_API_URL must be the profile's, and the API must receive the
// profile's declared identity to compare against its own.
check(
  envOf('web', 'AVENLYO_API_URL') === profile.AVENLYO_API_URL,
  "the web service's runtime AVENLYO_API_URL must come from the deployment profile",
);
check(
  envOf('api', 'AVENLYO_PROFILE_DEPLOYMENT_ENV') === declared,
  "the api service must receive the profile's declared deployment identity",
);
// And it must NOT receive the runtime identity from the profile: `environment:` overrides
// `env_file:`, so that would let a profile silently replace the identity api.env supplies.
check(
  envOf('api', 'AVENLYO_DEPLOYMENT_ENV') === null,
  'the profile must not override the api runtime AVENLYO_DEPLOYMENT_ENV from api.env',
);

const published = [...rendered.matchAll(/published: "(\d+)"/g)].map((match) => match[1]);
check(published.length === 3, `expected exactly 3 published ports, saw ${published.length}`);
for (const port of ['3000', '4000', '8080']) {
  check(!published.includes(port), `${port} must never be published to the host`);
}
for (const port of ['80', '443']) {
  check(published.includes(port), `caddy must publish ${port}`);
}

check(/init: true/.test(serviceBlock('api')), 'api lost init: true');
check(/no-new-privileges:true/.test(rendered), 'api lost no-new-privileges');
check(/chromium-seccomp\.json/.test(rendered), 'api lost the Chromium seccomp profile');
check(!/SYS_ADMIN/i.test(withoutComments(rendered)), 'SYS_ADMIN must never be added');

const release = profile.AVENLYO_RELEASE ?? '';
check(
  rendered.includes(`avenlyo-api:${release}`) && rendered.includes(`avenlyo-web:${release}`),
  'images must be tagged with the exact release',
);
check(!/avenlyo-(api|web):latest/.test(rendered), 'images must never be tagged latest');

// Caddy's upstreams are literals, in both profiles. An environment variable may choose a public
// name; it must never choose where Caddy sends traffic.
const upstreams = [...withoutComments(caddyfile).matchAll(/reverse_proxy\s+(\S+)/g)].map(
  (match) => match[1],
);
check(
  JSON.stringify(upstreams) === JSON.stringify(['web:3000', 'api:4000', 'api:4000']),
  `Caddy upstreams must stay source-controlled literals, saw ${upstreams.join(', ')}`,
);
check(
  (withoutComments(caddyfile).match(/import sanitized_forwarding/g) ?? []).length === 3,
  'forwarded-header replacement must apply to all three routes',
);
check(/^:8080 \{/m.test(withoutComments(caddyfile)), 'the internal :8080 listener must remain');

// ---------------------------------------------------------------------------------------------
if (failures.length > 0) {
  process.stderr.write(`deployment profile "${target}" FAILED:\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}

process.stdout.write(
  `deployment profile "${target}": PASS -- isolation, network separation, port policy, ` +
    'container hardening, SHA tagging and Caddy upstreams all verified from the rendered config\n',
);
