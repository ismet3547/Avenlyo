import { describe, expect, it } from 'vitest';

import { evaluateReleaseCheck, evaluateSmokeCheck, smokeTargets } from './smoke.js';

/**
 * Post-deploy verification.
 *
 * `smoke:production` answers a different question from `ops:preflight`: preflight asks whether a
 * configuration is safe to deploy, this asks whether what is now serving is the thing that was
 * deployed. Both are needed, and neither substitutes for the other.
 */

const SHA = 'c000caf742f7e4ca5d8dc85376931fcbb7a9e6a7';

describe('health checks accept only a healthy answer', () => {
  it('passes a 200 with the expected status word', () => {
    expect(evaluateSmokeCheck('api_live', { body: { status: 'ok' }, status: 200 }).ok).toBe(true);
    expect(evaluateSmokeCheck('api_ready', { body: { status: 'ready' }, status: 200 }).ok).toBe(
      true,
    );
  });

  it('fails a non-200, a wrong status word, and an unreachable endpoint', () => {
    expect(evaluateSmokeCheck('api_live', { body: { status: 'ok' }, status: 503 }).ok).toBe(false);
    expect(evaluateSmokeCheck('api_ready', { body: { status: 'ok' }, status: 200 }).ok).toBe(false);
    expect(evaluateSmokeCheck('api_live', null).ok).toBe(false);
  });
});

describe('targets are built from the base URLs only', () => {
  it('probes api health, and web health when a web base is supplied', () => {
    expect(smokeTargets({ apiBaseUrl: 'https://api.example/' }).map((t) => t.url)).toEqual([
      'https://api.example/health/live',
      'https://api.example/health/ready',
    ]);
    expect(
      smokeTargets({ apiBaseUrl: 'https://api.example', webBaseUrl: 'https://web.example/' }).map(
        (t) => t.name,
      ),
    ).toEqual(['api_live', 'api_ready', 'web_live']);
  });
});

describe('the release check catches a deploy that did not actually change', () => {
  it('passes when the deployment reports the release the operator shipped', () => {
    expect(
      evaluateReleaseCheck({ body: { release: SHA, status: 'ok' }, status: 200 }, SHA),
    ).toMatchObject({ name: 'api_release', ok: true });
  });

  it('fails when the deployment is healthy but still running the previous image', () => {
    // The failure `up -d` can produce silently: everything green, wrong bytes.
    const result = evaluateReleaseCheck(
      { body: { release: 'd34d28d7b053c6566a262698dc3f5d6ae0c1555f', status: 'ok' }, status: 200 },
      SHA,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('release_mismatch');
    // Neither SHA is echoed: the operator has both already, and a smoke is the wrong place to
    // start printing identifiers.
    expect(JSON.stringify(result)).not.toContain(SHA);
  });

  it('fails when the body carries no release at all', () => {
    expect(evaluateReleaseCheck({ body: { status: 'ok' }, status: 200 }, SHA)).toMatchObject({
      detail: 'release_missing',
      ok: false,
    });
  });

  it('fails when the deployment is unreachable', () => {
    expect(evaluateReleaseCheck(null, SHA)).toMatchObject({ detail: 'unreachable', ok: false });
  });
});
