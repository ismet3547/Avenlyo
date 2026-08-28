import {
  evaluateReleaseCheck,
  evaluateSmokeCheck,
  smokeTargets,
  summarizeSmokeResults,
  type SmokeCheckResult,
  type SmokeResponse,
} from '../observability/smoke.js';

/**
 * Deployment smoke check. Reads only the public health endpoints, so it requires no credential of
 * any kind and cannot mutate tenant or provider state.
 *
 * ## How it is run, and why the defaults are what they are
 *
 * It ships in the production bundle as `dist/scripts/smoke-production.js`, and the documented
 * operator invocation is a one-off container from the exact SHA-tagged image:
 *
 *   docker compose --env-file deploy/env/build.env -f deploy/compose.yaml \
 *     run --rm --no-deps -T api node dist/scripts/smoke-production.js
 *
 * That shape matters for the release assertion specifically. The one-off container is created from
 * `avenlyo-api:${AVENLYO_RELEASE}` -- the image the deployment profile *intended* -- while the
 * probes hit the public endpoints served by whatever is actually running. So falling back to this
 * container's own `AVENLYO_RELEASE` as the expectation is not circular: if `up` silently kept the
 * previous image, the running deployment reports the old SHA, this container expects the new one,
 * and the check fails. Which is the entire point of asserting the release at all.
 *
 * It would be circular under `exec`, which runs *inside* the already-running container: there the
 * expectation and the reported value come from the same process, and the check could never fail.
 * Use `run`, not `exec`, for this command. (`ops-status` is the opposite case and correctly uses
 * `exec` -- it describes the running deployment rather than checking it against an intent.)
 *
 * The base URLs fall back to the profile values Compose already passes into the API container, so
 * the documented command needs no arguments and is identical for staging and production. Every
 * fallback is non-secret -- two public URLs and a commit SHA -- and an explicit environment variable
 * always wins, so an ad-hoc run against any deployment still works.
 */

const REQUEST_TIMEOUT_MS = 10_000;

async function probe(url: string): Promise<SmokeResponse | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    return { body, status: response.status };
  } catch {
    return null;
  }
}

/** An explicit setting, else the deployment profile's own value, else undefined. Never a guess. */
function fromEnvironmentOrProfile(explicit: string, profile: string): string | undefined {
  const chosen = process.env[explicit]?.trim() || process.env[profile]?.trim();
  return chosen ? chosen : undefined;
}

async function main(): Promise<number> {
  const apiBaseUrl = fromEnvironmentOrProfile(
    'AVENLYO_API_BASE_URL',
    'AVENLYO_PROFILE_PUBLIC_API_URL',
  );
  if (!apiBaseUrl) {
    process.stderr.write(
      'AVENLYO_API_BASE_URL is required (or AVENLYO_PROFILE_PUBLIC_API_URL from the deployment profile).\n',
    );
    return 1;
  }

  const results: SmokeCheckResult[] = [];
  for (const target of smokeTargets({
    apiBaseUrl,
    webBaseUrl: fromEnvironmentOrProfile('AVENLYO_WEB_BASE_URL', 'AVENLYO_PROFILE_APP_URL'),
  })) {
    results.push(evaluateSmokeCheck(target.name, await probe(target.url)));
  }

  // Post-deploy the question is not only "is it up" but "is it the release we just shipped". A
  // smoke that skips this passes just as happily when `up` silently kept the previous image.
  // Asserted only when the operator states an expectation, so a run against an unknown deployment
  // stays useful rather than failing on one it invented.
  //
  // The fallback is this container's own AVENLYO_RELEASE, which under the documented `run` shape
  // comes from the deployment profile rather than from the deployment being probed -- see the
  // module comment for why that is a real check and not a tautology.
  const expectedRelease = fromEnvironmentOrProfile('AVENLYO_EXPECTED_RELEASE', 'AVENLYO_RELEASE');
  if (expectedRelease && expectedRelease !== 'unknown') {
    const live = await probe(`${apiBaseUrl.replace(/\/+$/, '')}/health/live`);
    results.push(evaluateReleaseCheck(live, expectedRelease));
  }

  for (const result of results) {
    process.stdout.write(`${result.ok ? 'pass' : 'FAIL'}  ${result.name}  ${result.detail}\n`);
  }

  const summary = summarizeSmokeResults(results);
  if (!summary.ok) {
    process.stderr.write(`Smoke checks failed: ${summary.failed.join(', ')}\n`);
    return 1;
  }
  return 0;
}

process.exitCode = await main();
