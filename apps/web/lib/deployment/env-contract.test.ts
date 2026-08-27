import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The deployment template has to describe what the web server actually reads.
 *
 * This exists because of a real staging failure. `apps/web/lib/knowledge/config.ts` reads
 * `OPENAI_API_KEY` and treats it as optional at boot, so the container starts perfectly well
 * without it -- and then publishing a reviewed import fails at the moment an operator clicks
 * publish, with a message about configuration they had every reason to believe was already done.
 * The key was in `/etc/avenlyo/api.env`. It was missing from `/etc/avenlyo/web.env` because
 * `deploy/env/web.env.example` never mentioned it.
 *
 * A template that silently omits a variable is worse than one that is wrong: nothing fails until a
 * human exercises the feature. So the invariant is checked here rather than trusted to review --
 * every server-only variable the web app reads must appear in the template, and nothing that
 * belongs elsewhere may appear in it.
 *
 * It is deliberately a source scan, not a hand-written list. A list would need updating by exactly
 * the person who forgot to update the template.
 */

function repositoryRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;
    directory = dirname(directory);
  }
  throw new Error('Could not locate the repository root.');
}

const root = repositoryRoot();
const webEnvExample = readFileSync(join(root, 'deploy/env/web.env.example'), 'utf8');
const buildEnvExample = readFileSync(join(root, 'deploy/env/build.env.example'), 'utf8');

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

/** Every `process.env.X` the shipped web app reads, tests excluded. */
function environmentReads(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(join(root, 'apps/web'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      names.add(match[1]!);
    }
  }
  return names;
}

/**
 * Names the template is not responsible for.
 *
 * `NEXT_PUBLIC_*` is compiled into the bundle at `next build` and belongs to build.env; setting it
 * in web.env would do nothing at all. `NODE_ENV` is set by the image, not by an operator.
 */
function isServerRuntimeVariable(name: string): boolean {
  return !name.startsWith('NEXT_PUBLIC_') && name !== 'NODE_ENV';
}

/** A name counts as documented whether it ships set or commented out as an optional override. */
function documentedIn(template: string, name: string): boolean {
  return new RegExp(`^#?\\s*${name}=`, 'm').test(template);
}

describe('deploy/env/web.env.example describes the web runtime', () => {
  const reads = [...environmentReads()].sort();

  it('finds the variables the web app reads', () => {
    // Guards the scan itself: a regex that quietly matched nothing would make every assertion
    // below pass without checking anything.
    expect(reads).toContain('OPENAI_API_KEY');
    expect(reads).toContain('AVENLYO_INTERNAL_BILLING_SECRET');
    expect(reads.length).toBeGreaterThan(5);
  });

  it.each(reads.filter(isServerRuntimeVariable))('documents %s', (name) => {
    expect(documentedIn(webEnvExample, name)).toBe(true);
  });

  it('documents OPENAI_API_KEY as a value an operator must actually set', () => {
    // Not commented out. The three knowledge features that need it are the point of this stage of
    // staging, and a commented-out line reads as "optional extra" rather than "publish fails".
    expect(webEnvExample).toMatch(/^OPENAI_API_KEY=$/m);
  });

  it('never carries a build-time value that would silently do nothing', () => {
    for (const name of reads.filter((entry) => entry.startsWith('NEXT_PUBLIC_'))) {
      expect(documentedIn(webEnvExample, name)).toBe(false);
    }
  });

  it('never carries the service-role key', () => {
    // Web uses the anon key plus the caller's own session. The service-role key bypasses every RLS
    // policy in the database, and the browser-facing server is the last process that should hold it.
    expect(webEnvExample).not.toMatch(/^#?\s*SUPABASE_SERVICE_ROLE_KEY=/m);
  });

  it('keeps the OpenAI key out of the browser bundle', () => {
    // build.env values are inlined into client JavaScript by Next.js at build time.
    expect(buildEnvExample).not.toMatch(/OPENAI/);
    expect(webEnvExample).not.toMatch(/^#?\s*NEXT_PUBLIC_OPENAI/m);
  });

  it('does not invent OpenAI settings the web app never reads', () => {
    // Voice and webhook configuration belongs to the API. Copying it here would hand the web
    // container credentials it has no code path for.
    for (const unused of ['OPENAI_PROJECT_ID', 'OPENAI_REALTIME_MODEL', 'OPENAI_WEBHOOK_SECRET']) {
      expect(reads).not.toContain(unused);
      expect(documentedIn(webEnvExample, unused)).toBe(false);
    }
  });
});
