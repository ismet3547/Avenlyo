import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The env-migration verifier, executed rather than read.
 *
 * This exists because the previous version of this check was documented as three lines of shell
 * that a source-string assertion happily confirmed were present -- and which did the opposite of
 * what the runbook claimed:
 *
 *     cmp -s "$A" "$B" && echo "verified: ..." || echo "REFUSED: ..."
 *
 * When `cmp` fails the `||` branch runs `echo`, `echo` succeeds, and the compound command exits 0.
 * The runbook said an unintended change exits non-zero; it exited 0, so a scripted deploy would
 * have carried on past a file the check had just refused. Asserting that the text appears in the
 * documentation could never have caught that. Running it does.
 *
 * So every case below spawns the real script against real fixture files. The fixtures carry
 * secret-shaped values on purpose: the third assertion is that a refusal names the key and nothing
 * else, because a verification that leaks the value it refused is worse than no verification.
 */

const run = promisify(execFile);
const SCRIPT = 'deploy/scripts/verify-env-migration.sh';

/**
 * Secret-shaped fixture values, so a leak in the output would be unmistakable.
 *
 * Assembled at runtime rather than written as literals. The value has to look like a real
 * credential for the leak assertions below to mean anything, and a literal that looks like a real
 * credential is exactly what GitHub push protection blocks — correctly, since a scanner cannot know
 * a `sk_live_…` string in a source file is a fixture. Building it from parts keeps the runtime value
 * realistic while leaving no matching literal in the file.
 *
 * Please do not "tidy" these back into single strings: the push will be rejected, and the right
 * response to that rejection is never the bypass link.
 */
const LIVE_PREFIX = ['sk', 'live', ''].join('_');
const SERVICE_KEY = `${LIVE_PREFIX}51NEVERPRINTTHISVALUEANYWHERE`;
const ROTATED_KEY = `${LIVE_PREFIX}51ADIFFERENTVALUETHATLEAKED`;

let directory: string;

/** Absolute paths, because the script is invoked from the repository root. */
const at = (name: string) => join(directory, name);

async function fixture(name: string, lines: readonly string[]): Promise<string> {
  const path = at(name);
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

interface Outcome {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function verify(...args: readonly string[]): Promise<Outcome> {
  try {
    const { stderr, stdout } = await run('bash', [SCRIPT, ...args]);
    return { code: 0, stderr, stdout };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string; stdout?: string };
    return { code: failure.code ?? -1, stderr: failure.stderr ?? '', stdout: failure.stdout ?? '' };
  }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'avenlyo-env-migration-'));
});

afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe('the web.env AVENLYO_API_URL removal verification', () => {
  it('exits 0 when only the obsolete assignment was removed', async () => {
    const backup = await fixture('web.bak', [
      'AVENLYO_RELEASE=c000caf742f7e4ca5d8dc85376931fcbb7a9e6a7',
      'AVENLYO_API_URL=http://caddy:8080',
      `OPENAI_API_KEY=${SERVICE_KEY}`,
    ]);
    const live = await fixture('web.live', [
      'AVENLYO_RELEASE=c000caf742f7e4ca5d8dc85376931fcbb7a9e6a7',
      `OPENAI_API_KEY=${SERVICE_KEY}`,
    ]);

    const outcome = await verify(backup, live, 'AVENLYO_API_URL', '1', '0');

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('verified: only the AVENLYO_API_URL assignment changed');
  });

  it('exits non-zero when a second, unintended change slipped in', async () => {
    // The case the old shape got wrong. A rotated secret pasted into the wrong file, an editor
    // mangling a line -- the migration must refuse, and the refusal must be an exit code that
    // automation can act on rather than a message nobody reads.
    const backup = await fixture('web2.bak', [
      'AVENLYO_API_URL=http://caddy:8080',
      `OPENAI_API_KEY=${SERVICE_KEY}`,
    ]);
    const live = await fixture('web2.live', [`OPENAI_API_KEY=${ROTATED_KEY}`]);

    const outcome = await verify(backup, live, 'AVENLYO_API_URL', '1', '0');

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('REFUSED');
  });

  it('leaks no value when it refuses', async () => {
    const backup = await fixture('web3.bak', [
      'AVENLYO_API_URL=http://caddy:8080',
      `OPENAI_API_KEY=${SERVICE_KEY}`,
    ]);
    const live = await fixture('web3.live', [`OPENAI_API_KEY=${ROTATED_KEY}`]);

    const outcome = await verify(backup, live, 'AVENLYO_API_URL', '1', '0');
    const output = `${outcome.stdout}${outcome.stderr}`;

    for (const secret of [SERVICE_KEY, ROTATED_KEY, LIVE_PREFIX, 'OPENAI_API_KEY']) {
      expect(output).not.toContain(secret);
    }
    // Fixed, source-controlled text plus the key NAME and two counts. Nothing else.
    expect(output.trim()).toBe(
      'REFUSED: something other than AVENLYO_API_URL changed; restore from the backup and investigate',
    );
  });

  it('exits non-zero when the obsolete assignment was never removed', async () => {
    const backup = await fixture('web4.bak', ['AVENLYO_API_URL=http://caddy:8080', 'X=1']);
    const live = await fixture('web4.live', ['AVENLYO_API_URL=http://caddy:8080', 'X=1']);

    const outcome = await verify(backup, live, 'AVENLYO_API_URL', '1', '0');

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('assignment count is 1 -> 1, expected 1 -> 0');
  });
});

describe('the api.env AVENLYO_DEPLOYMENT_ENV addition verification', () => {
  it('exits 0 when only the deployment identity was added', async () => {
    const backup = await fixture('api.bak', [
      'NODE_ENV=production',
      `SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}`,
    ]);
    const live = await fixture('api.live', [
      'NODE_ENV=production',
      `SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}`,
      'AVENLYO_DEPLOYMENT_ENV=staging',
    ]);

    const outcome = await verify(backup, live, 'AVENLYO_DEPLOYMENT_ENV', '0', '1');

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('verified: only the AVENLYO_DEPLOYMENT_ENV assignment changed');
  });

  it('exits non-zero, and leaks nothing, when another line also changed', async () => {
    const backup = await fixture('api2.bak', [
      'NODE_ENV=production',
      `SUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}`,
    ]);
    const live = await fixture('api2.live', [
      'NODE_ENV=development',
      `SUPABASE_SERVICE_ROLE_KEY=${ROTATED_KEY}`,
      'AVENLYO_DEPLOYMENT_ENV=staging',
    ]);

    const outcome = await verify(backup, live, 'AVENLYO_DEPLOYMENT_ENV', '0', '1');
    const output = `${outcome.stdout}${outcome.stderr}`;

    expect(outcome.code).not.toBe(0);
    for (const secret of [SERVICE_KEY, ROTATED_KEY, LIVE_PREFIX, 'NODE_ENV']) {
      expect(output).not.toContain(secret);
    }
  });

  it('exits non-zero when the identity was added twice', async () => {
    const backup = await fixture('api3.bak', ['NODE_ENV=production']);
    const live = await fixture('api3.live', [
      'NODE_ENV=production',
      'AVENLYO_DEPLOYMENT_ENV=staging',
      'AVENLYO_DEPLOYMENT_ENV=production',
    ]);

    const outcome = await verify(backup, live, 'AVENLYO_DEPLOYMENT_ENV', '0', '1');

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('assignment count is 0 -> 2, expected 0 -> 1');
  });
});

describe('the verifier refuses malformed invocations rather than guessing', () => {
  it('rejects a missing file', async () => {
    const backup = await fixture('m.bak', ['X=1']);

    const outcome = await verify(backup, at('does-not-exist'), 'X', '1', '1');

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('does not exist');
  });

  it('rejects the wrong number of arguments', async () => {
    const outcome = await verify(at('m.bak'));

    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('usage:');
  });

  it('rejects a key that is not a plain variable name', async () => {
    // The key is interpolated into a grep pattern, so it must not be able to carry one.
    //
    // Deliberately not a glob such as `.*`: Git Bash on Windows expands one into a directory
    // listing before the script is even reached, which would make this assert the MSYS argument
    // layer rather than the script. These two are invalid keys on every platform.
    const backup = await fixture('k.bak', ['X=1']);
    const live = await fixture('k.live', ['X=1']);

    for (const key of ['9INVALID', 'KEY-WITH-DASH']) {
      const outcome = await verify(backup, live, key, '1', '1');

      expect(outcome.code).not.toBe(0);
      expect(outcome.stderr).toContain('plain environment variable name');
    }
  });
});

describe('the verifier never relies on && / || precedence', () => {
  /**
   * The defect in one sentence: `cmp -s A B && echo ok || echo REFUSED` exits 0 when cmp fails,
   * because the `||` branch's `echo` succeeds. Pinned at the source level too, because this is a
   * shape that reads correct and behaves wrongly, and the next person to touch the file should be
   * stopped by a test rather than by a staging incident.
   */
  it('uses a guarded if/else with an explicit failing exit', async () => {
    const source = await readFile(SCRIPT, 'utf8');
    // Comments stripped: the header quotes the defective shape on purpose, to explain it.
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    expect(code).toMatch(/if cmp -s "\$filtered_backup" "\$filtered_live"; then/);
    expect(code).toContain('exit 1');
    expect(code).not.toMatch(/cmp[^\n]*&&[^\n]*\|\|/);
  });

  it('cleans its temporary files on every exit path', async () => {
    const source = await readFile(SCRIPT, 'utf8');

    expect(source).toContain('trap cleanup EXIT');
    expect(source).toContain('rm -f "$filtered_backup" "$filtered_live"');
  });

  it('fails fast rather than continuing past an error', async () => {
    expect(await readFile(SCRIPT, 'utf8')).toContain('set -euo pipefail');
  });
});

describe('the runbook documents the verifier it actually ships', () => {
  const runbook = async () =>
    (await readFile('docs/production-runbook.md', 'utf8')).replace(/\r\n/g, '\n');

  it('invokes the script for both migrations', async () => {
    // Whitespace-normalised: the documented commands wrap across lines with a backslash, and the
    // assertion is about the invocation, not about where the line breaks fall.
    const text = (await runbook()).replace(/\\\n\s*/g, '').replace(/[ \t]+/g, ' ');

    expect(text).toContain(
      'deploy/scripts/verify-env-migration.sh "$BK/web.env.bak" /etc/avenlyo/web.env AVENLYO_API_URL 1 0',
    );
    expect(text).toContain(
      'deploy/scripts/verify-env-migration.sh "$BK/api.env.bak" /etc/avenlyo/api.env AVENLYO_DEPLOYMENT_ENV 0 1',
    );
  });

  it('no longer documents the fail-open shell shape', async () => {
    const text = await runbook();

    expect(text).not.toMatch(/cmp -s[^\n]*&&[^\n]*\\?\s*$/m);
    expect(text).not.toContain('|| echo "REFUSED');
  });

  it('still promises a non-zero exit, which is now true', async () => {
    const text = (await runbook()).replace(/\s+/g, ' ');

    expect(text).toContain('exits non-zero');
  });
});
