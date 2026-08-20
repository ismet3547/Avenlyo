import {
  evaluateSmokeCheck,
  smokeTargets,
  summarizeSmokeResults,
  type SmokeCheckResult,
  type SmokeResponse,
} from '../observability/smoke.js';

/**
 * Deployment smoke check. Reads only the public health endpoints, so it requires no credential of
 * any kind and cannot mutate tenant or provider state.
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

async function main(): Promise<number> {
  const apiBaseUrl = process.env.AVENLYO_API_BASE_URL;
  if (!apiBaseUrl) {
    process.stderr.write('AVENLYO_API_BASE_URL is required.\n');
    return 1;
  }

  const results: SmokeCheckResult[] = [];
  for (const target of smokeTargets({
    apiBaseUrl,
    webBaseUrl: process.env.AVENLYO_WEB_BASE_URL,
  })) {
    results.push(evaluateSmokeCheck(target.name, await probe(target.url)));
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
