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

const [, , target, envFile] = process.argv;

if (target !== 'staging' && target !== 'production') {
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
