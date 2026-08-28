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
// SOURCE reading -- for the properties that are about PROVENANCE, not final values.
// ---------------------------------------------------------------------------------------------
/**
 * `docker compose config` is not a source document.
 *
 * Compose resolves `env_file:` into the rendered service `environment:` map, so on a real host every
 * assignment in /etc/avenlyo/api.env appears there and `env_file:` disappears from the output. A
 * rendered environment therefore cannot answer "where did this value come from" -- it only answers
 * "what is the final value".
 *
 * That distinction was the Phase 21A staging failure. A check asking whether the profile overrides
 * the API's runtime deployment identity was written against the render, so a correctly configured
 * host -- one whose api.env declares AVENLYO_DEPLOYMENT_ENV=staging, exactly as Phase 20 requires --
 * failed the gate. CI never caught it because its fixture wrote an EMPTY api.env, and with nothing to
 * merge the check passed vacuously.
 *
 * So provenance is asserted against deploy/compose.yaml itself, and the render is used only for
 * properties that genuinely concern final rendered values (ports, networks, image tags, hardening).
 *
 * Newlines are normalised because a CRLF checkout would otherwise leave a trailing \r on every key
 * and silently match nothing.
 */
const composeSource = readFileSync('deploy/compose.yaml', 'utf8').replace(/\r\n/g, '\n');

/** The lines belonging to one service in the SOURCE file, up to the next two-space key. */
const sourceServiceLines = (name) => {
  const lines = composeSource.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
};

/**
 * The service's own `environment:` entries in the SOURCE file, as `{key: rawValue}`.
 *
 * Blank lines and comment lines inside the block are skipped rather than treated as its end -- the
 * block in deploy/compose.yaml carries a long explanatory comment between entries, and a parser that
 * stopped at the first comment would report the block as nearly empty and pass everything.
 */
const sourceEnvironment = (name) => {
  const lines = sourceServiceLines(name);
  const header = lines.indexOf('    environment:');
  if (header === -1) return {};
  const entries = {};
  for (const line of lines.slice(header + 1)) {
    if (line.trim() === '' || /^ {6,}#/.test(line)) continue;
    if (!line.startsWith('      ')) break;
    const match = line.match(/^ {6}([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/);
    if (match) entries[match[1]] = match[2].trim();
  }
  return entries;
};

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

// ---------------------------------------------------------------------------------------------
// The profile actually reached the deployment -- asserted on the specific rendered keys the
// profile feeds, never by scanning the whole document.
// ---------------------------------------------------------------------------------------------
// A whole-document scan cannot be used for this: `env_file:` is merged into the render, so a host
// whose api.env legitimately carries API_CORS_ORIGIN=https://staging.avenlyo.com would make a
// production profile look cross-wired. These are the keys Compose fills FROM the profile, so they
// are the keys that answer the question.
const PROFILE_FED_RENDERED_KEYS = [
  ['caddy', 'AVENLYO_WEB_HOST'],
  ['caddy', 'AVENLYO_API_HOST'],
  ['api', 'AVENLYO_PROFILE_APP_URL'],
  ['api', 'AVENLYO_PROFILE_PUBLIC_API_URL'],
  ['api', 'AVENLYO_PROFILE_WEB_HOST'],
  ['api', 'AVENLYO_PROFILE_API_HOST'],
];

if (target === 'production') {
  // The Caddyfile's substitution defaults are the staging names, so this is what proves the
  // production profile actually overrode them rather than falling through to the default.
  for (const [service, key] of PROFILE_FED_RENDERED_KEYS) {
    const value = envOf(service, key) ?? '';
    for (const host of STAGING_HOSTS) {
      check(!value.includes(host), `rendered ${service}.${key} still carries the staging host ${host}`);
    }
  }
}

if (target === 'staging') {
  check(
    envOf('caddy', 'AVENLYO_WEB_HOST') === profile.AVENLYO_WEB_HOST,
    "Caddy's rendered web hostname must come from the deployment profile",
  );
  check(
    envOf('caddy', 'AVENLYO_API_HOST') === profile.AVENLYO_API_HOST,
    "Caddy's rendered API hostname must come from the deployment profile",
  );
}

// ---------------------------------------------------------------------------------------------
// Provenance: asserted against the SOURCE compose file, never the render.
// ---------------------------------------------------------------------------------------------
const apiSourceEnv = sourceEnvironment('api');
const webSourceEnv = sourceEnvironment('web');

// Guards the parser itself. If the block were mis-parsed as empty, every absence check below would
// pass while proving nothing -- which is the failure mode this whole section exists to avoid.
check(
  Object.keys(apiSourceEnv).length >= 6,
  `the api source environment block parsed as ${Object.keys(apiSourceEnv).length} entries; the parser is wrong`,
);
check(
  Object.keys(webSourceEnv).length >= 2,
  `the web source environment block parsed as ${Object.keys(webSourceEnv).length} entries; the parser is wrong`,
);

// The runtime deployment identity must keep coming from /etc/avenlyo/api.env. Compose's
// `environment:` overrides `env_file:`, so declaring this key here would let the deployment profile
// silently replace the container's own identity -- with an empty string whenever the profile omitted
// it, which does not merely mis-identify the deployment, it stops the container booting.
check(
  !('AVENLYO_DEPLOYMENT_ENV' in apiSourceEnv),
  "deploy/compose.yaml's api environment: must not declare AVENLYO_DEPLOYMENT_ENV; the runtime " +
    'identity belongs to /etc/avenlyo/api.env',
);

// The profile's own identity is mirrored under a distinct name instead, with required substitution,
// so preflight can compare the two files rather than let one overwrite the other.
check(
  /^\$\{AVENLYO_DEPLOYMENT_ENV:\?/.test(apiSourceEnv.AVENLYO_PROFILE_DEPLOYMENT_ENV ?? ''),
  'the api service must mirror the profile identity as ' +
    'AVENLYO_PROFILE_DEPLOYMENT_ENV: ${AVENLYO_DEPLOYMENT_ENV:?...}',
);

// The EXPECTED Supabase project ref must reach the API from the deployment profile, under a
// distinct name. This was a real defect: the profile declared the key, nothing forwarded it, and the
// value was inert -- so the documented production path failed with an undeclared project identity
// unless the operator duplicated it into api.env, which is precisely where it must NOT live. The
// ACTUAL identity (SUPABASE_URL) stays in api.env; an expectation stored beside the value it checks
// cannot detect a cross-wire.
check(
  /^\$\{AVENLYO_EXPECTED_SUPABASE_PROJECT_REF:-\}?$/.test(
    apiSourceEnv.AVENLYO_PROFILE_EXPECTED_SUPABASE_PROJECT_REF ?? '',
  ),
  'the api service must mirror the profile expectation as ' +
    'AVENLYO_PROFILE_EXPECTED_SUPABASE_PROJECT_REF: ${AVENLYO_EXPECTED_SUPABASE_PROJECT_REF:-}',
);
// And the runtime name must never be supplied from the profile: that would put the expectation back
// into the same precedence chain as api.env and re-create the single-authority problem.
check(
  !('AVENLYO_EXPECTED_SUPABASE_PROJECT_REF' in apiSourceEnv),
  "deploy/compose.yaml's api environment: must not declare AVENLYO_EXPECTED_SUPABASE_PROJECT_REF; " +
    'the profile value is mirrored under the AVENLYO_PROFILE_ name',
);

// Same provenance question for the internal boundary. The rendered equality check below cannot
// answer it: `environment:` wins over `env_file:`, so a host still carrying a stale
// AVENLYO_API_URL in /etc/avenlyo/web.env would render the profile's value either way.
check(
  /^\$\{AVENLYO_API_URL:\?/.test(webSourceEnv.AVENLYO_API_URL ?? ''),
  "the web service's AVENLYO_API_URL must be sourced from the deployment profile as " +
    '${AVENLYO_API_URL:?...}',
);

// And the final rendered value must be the profile's, which is a statement about the value rather
// than about where the declaration lives -- so this one legitimately reads the render.
check(
  envOf('web', 'AVENLYO_API_URL') === profile.AVENLYO_API_URL,
  "the web service's rendered AVENLYO_API_URL must equal the deployment profile's value",
);
check(
  envOf('api', 'AVENLYO_PROFILE_DEPLOYMENT_ENV') === declared,
  "the api service must receive the profile's declared deployment identity",
);
check(
  envOf('api', 'AVENLYO_PROFILE_EXPECTED_SUPABASE_PROJECT_REF') ===
    (profile.AVENLYO_EXPECTED_SUPABASE_PROJECT_REF ?? ''),
  "the api service must receive the profile's expected Supabase project ref",
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
// Asserted on the source, plus on the rendered capability lists specifically. A whole-render scan
// would be reading merged env_file values too -- the same source/render confusion fixed above, and
// a capability grant is a source decision in any case.
check(!/SYS_ADMIN/i.test(withoutComments(composeSource)), 'SYS_ADMIN must never be added');
const grantedCapabilities = [...rendered.matchAll(/^\s+cap_add:\n((?:\s+- .*\n)+)/gm)]
  .flatMap((match) => match[1].split('\n'))
  .map((line) => line.replace(/^\s*-\s*/, '').trim())
  .filter(Boolean);
check(
  !grantedCapabilities.some((capability) => /^SYS_ADMIN$/i.test(capability)),
  `SYS_ADMIN must never be granted, saw ${grantedCapabilities.join(', ') || 'none'}`,
);

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
